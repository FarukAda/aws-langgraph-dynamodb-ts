import { randomUUID } from 'node:crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';

import {
  conditionalCheckFailure,
  getCancellationReasons,
  type RejectionFields,
} from '../../src/shared/dynamodb/cancellation';
import {
  isConditionalCheckFailed,
  rejectedItem,
  revisionGuard,
} from '../../src/shared/dynamodb/conditional-put';
import { putIdempotently } from '../../src/shared/dynamodb/idempotent-write';
import { ErrorCode } from '../../src/shared/errors/error-code';
import { liveRegion } from './helpers/env';
import { countTransactAttempts, report, rejection } from './helpers/probe';
import { createTestTable } from './helpers/table';
import { deleteTableCompletely, settleAll } from './helpers/teardown';

const clientConfig = { region: liveRegion() };
const tableName = `aws-langgraph-idemtest-${randomUUID()}`;

/** How many writers race one row in the contention arm. */
const WRITERS = 5;

/**
 * The write the design sends: a **one-item** `TransactWriteItems` carrying a
 * `Put`, a condition, `ALL_OLD` and a client request token. Everything in this
 * file is a statement about that exact shape, so it is built in one place.
 */
function tokenedPut(
  token: string,
  item: Record<string, string>,
  guarded: boolean,
): TransactWriteCommandInput {
  const guard = guarded ? revisionGuard('rev', { exists: false }) : {};
  return {
    ClientRequestToken: token,
    TransactItems: [{ Put: { TableName: tableName, Item: item, ...guard } }],
  };
}

/**
 * The live assertions the **write** side of the offload-durability design rests
 * on, each asserting a claim recorded in `docs/evidence` (E-1 through E-6), so
 * that they run before every tag instead of living in a markdown file that
 * nothing re-checks.
 *
 * None of these can be carried by DynamoDB Local, and E-3 least of all: there a
 * cancelled token reserves nothing, so the local image answers a changed body
 * by re-evaluating it. Everything here needs a real service.
 *
 * Creates and tears down one on-demand table per run.
 */
describe('the idempotency contract this design rests on, against real AWS', () => {
  let admin: DynamoDBClient;
  let doc: DynamoDBDocument;

  beforeAll(async () => {
    admin = new DynamoDBClient(clientConfig);
    doc = DynamoDBDocument.from(admin);
    await createTestTable(admin, tableName);
  });

  afterAll(async () => {
    await settleAll([
      async () => {
        if (!admin) return;
        await deleteTableCompletely(admin, tableName);
        admin.destroy();
      },
    ]);
  });

  /**
   * (docs/evidence/cancelled-transaction-token.md, E-1) — the one assertion
   * the whole prevention layer rests on, and the reason every other assertion
   * in this file is interpretable at all.
   *
   * The library uploads an object, then commits the row that names it. If a
   * re-sent write could land a second time, the cleanup that follows a lost
   * acknowledgement would release an object the other attempt's row still
   * names, and the checkpoint would become permanently unreadable. Deleting the
   * row between the two sends is what makes this a real test: a replay that was
   * genuinely re-evaluated would recreate it.
   */
  it('E-1: answers a replayed completed token from the cache and writes nothing', async () => {
    const token = randomUUID();
    const input = tokenedPut(token, { PK: 'l1', SK: 'row', marker: 'first' }, false);

    const first = await doc.transactWrite(input);
    expect(first.$metadata.httpStatusCode).toBe(200);
    await doc.delete({ TableName: tableName, Key: { PK: 'l1', SK: 'row' } });

    const replay = await doc.transactWrite(input);
    expect(replay.$metadata.httpStatusCode).toBe(200);

    const after = await doc.get({
      TableName: tableName,
      Key: { PK: 'l1', SK: 'row' },
      ConsistentRead: true,
    });
    expect(after.Item).toBeUndefined();
  });

  /**
   * (docs/evidence/cancelled-transaction-token.md, E-2) — a cancelled token
   * caches no result.
   *
   * The replay does not merely fail again: the blocker is gone by then, so
   * re-evaluation succeeds and writes the row. That is the strongest possible
   * form of "not cached", and it is what makes the exactly-once sentence this
   * release ships precise — a write whose first attempt was *rejected* carries
   * no idempotency at all, and its retry is a fresh evaluation against the
   * table as it stands at retry time.
   */
  it('E-2: re-evaluates and applies a replayed cancelled token once the blocker is gone', async () => {
    await doc.put({ TableName: tableName, Item: { PK: 'l2', SK: 'row', blocker: 'yes' } });
    const input = tokenedPut(randomUUID(), { PK: 'l2', SK: 'row', marker: 'replay' }, true);

    const refused = await rejection(doc.transactWrite(input));
    expect(refused.name).toBe('TransactionCanceledException');
    expect(conditionalCheckFailure(refused as RejectionFields)).toBeDefined();

    await doc.delete({ TableName: tableName, Key: { PK: 'l2', SK: 'row' } });
    const replay = await doc.transactWrite(input);
    expect(replay.$metadata.httpStatusCode).toBe(200);

    const after = await doc.get({
      TableName: tableName,
      Key: { PK: 'l2', SK: 'row' },
      ConsistentRead: true,
    });
    expect(after.Item).toEqual({ PK: 'l2', SK: 'row', marker: 'replay' });
  });

  /**
   * (docs/evidence/cancelled-transaction-token.md, E-3) — the re-pin refusal,
   * and **the one assertion in this repository that only real AWS can make**.
   *
   * A cancelled use caches no result but still reserves its *parameters*, so
   * the same token presented with a changed body inside the ten-minute window
   * is refused with `IdempotentParameterMismatchException` — a name that is in
   * no retry list and in no handler in this package, so a helper that reused a
   * token across a compare-and-swap re-pin would surface a raw SDK error to a
   * caller. This is what makes "a re-pin draws a fresh token" a necessary rule
   * rather than merely a tidy one.
   *
   * Do not move this into the integration tier and do not "simplify" it into
   * E-1. DynamoDB Local does not reserve a cancelled token's parameters and
   * simply re-evaluates the changed body, so the assertion silently inverts
   * there. And a re-send of an *identical* request proves E-1, not this: the
   * mismatch needs the same token with different parameters, which is the
   * adjacent mistake.
   */
  it('E-3: refuses a cancelled token re-sent with a changed body', async () => {
    const token = randomUUID();
    await doc.put({ TableName: tableName, Item: { PK: 'l8', SK: 'row', blocker: 'yes' } });

    const first = await rejection(
      doc.transactWrite(tokenedPut(token, { PK: 'l8', SK: 'row' }, true)),
    );
    expect(first.name).toBe('TransactionCanceledException');

    await doc.delete({ TableName: tableName, Key: { PK: 'l8', SK: 'row' } });
    // Nothing but the token can refuse this now: the blocker is gone and the
    // body is the only thing that changed.
    const changed = tokenedPut(token, { PK: 'l8', SK: 'row', marker: 'changed' }, true);
    const mismatch = await rejection(doc.transactWrite(changed));
    expect(mismatch.name).toBe('IdempotentParameterMismatchException');

    const after = await doc.get({
      TableName: tableName,
      Key: { PK: 'l8', SK: 'row' },
      ConsistentRead: true,
    });
    expect(after.Item).toBeUndefined();
  });

  /**
   * (docs/evidence/transaction-rejected-row.md, E-4) — the cancellation's
   * `Item` is raw.
   *
   * The document client unmarshalls a *response* but not an *error payload*,
   * so a row attached to a cancellation reason arrives in DynamoDB's own
   * attribute-value shape, nested maps and lists included — and byte-identical
   * to what the same client leaves on a `PutCommand` rejection. That identity
   * is why `rejectedItem` needs exactly one unmarshall path with two places to
   * look, rather than two decoders that can drift apart.
   *
   * It asserts the shape rather than merely that a row came back: a test that
   * only checked for presence would pass just as well against an already
   * unmarshalled item, which is the change that would break the caller.
   */
  it('E-4: attaches the rejected row as raw attribute values, exactly as a PutCommand does', async () => {
    const row = { PK: 'l4', SK: 'row', rev: 7, note: 'old', tags: ['a', 'b'], nested: { n: 1 } };
    await doc.put({ TableName: tableName, Item: row });
    const guard = revisionGuard('rev', { exists: false });

    const cancelled = await rejection(
      doc.transactWrite({
        ClientRequestToken: randomUUID(),
        TransactItems: [
          { Put: { TableName: tableName, Item: { PK: 'l4', SK: 'row', note: 'new' }, ...guard } },
        ],
      }),
    );
    const reason = conditionalCheckFailure(cancelled);
    expect(reason?.Code).toBe('ConditionalCheckFailed');
    expect(reason?.Item).toEqual({
      PK: { S: 'l4' },
      SK: { S: 'row' },
      rev: { N: '7' },
      note: { S: 'old' },
      tags: { L: [{ S: 'a' }, { S: 'b' }] },
      nested: { M: { n: { N: '1' } } },
    });
    // The library's single decoder turns that back into the row a re-pin needs.
    expect(rejectedItem(cancelled)).toEqual(row);

    const refusedPut = await rejection(
      doc.put({ TableName: tableName, Item: { PK: 'l4', SK: 'row', note: 'new' }, ...guard }),
    );
    expect(refusedPut.name).toBe('ConditionalCheckFailedException');
    expect((refusedPut as { Item?: object }).Item).toEqual(reason?.Item);
  });

  /**
   * (docs/evidence/transaction-conflict-contention.md, E-5) — that the
   * design's write shape genuinely meets a *different* failure under
   * contention, `TransactionConflict`, not only `ConditionalCheckFailed`, and
   * that a plain conditional `PutItem` racing itself (no transaction
   * involved) never does.
   *
   * Driven by raw `doc.transactWrite` calls at `maxAttempts: 1`, bypassing the
   * library's own retry helper entirely (see E-6 for that), so a conflict
   * cannot be silently absorbed before it is counted.
   *
   * This asserts only that the failure **occurs**, not how often. The evidence
   * file records a 65 % rate at this same five-writer width, but that figure
   * is an aggregate over four rounds with no per-round breakdown recorded — the
   * source's own numbers are consistent with a round where only one of five
   * writers conflicted. A release-gating live test cannot bound round-to-round
   * variance it was never given, so pinning any threshold above "at least one"
   * here would risk failing this gate on an ordinary day rather than a real
   * regression. See the evidence file for the measured rate as a recorded
   * observation, not a contract this test checks.
   */
  it('E-5: at least one concurrent conditional writer on one row meets the retryable TransactionConflict failure, and a plain PutItem control meets none', async () => {
    const base = new DynamoDBClient({ ...clientConfig, maxAttempts: 1 });
    const raw = DynamoDBDocument.from(base);

    const transactional = await Promise.allSettled(
      Array.from({ length: WRITERS }, async (_unused, writer) =>
        raw.transactWrite(
          tokenedPut(randomUUID(), { PK: 'e5-txn', SK: 'row', writer: String(writer) }, true),
        ),
      ),
    );
    const conflicted = transactional.filter((result) => {
      if (result.status === 'fulfilled') return false;
      const reasons = getCancellationReasons(result.reason as RejectionFields) ?? [];
      return reasons.some((reason) => reason.Code === 'TransactionConflict');
    });

    const control = await Promise.allSettled(
      Array.from({ length: WRITERS }, async (_unused, writer) =>
        raw.put({
          TableName: tableName,
          Item: { PK: 'e5-control', SK: 'row', writer: String(writer) },
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      ),
    );
    const controlConflicted = control.filter(
      (result) =>
        result.status === 'rejected' &&
        (result.reason as Error).name === 'TransactionConflictException',
    );
    base.destroy();

    report(
      `E-5 ${WRITERS} writers on one row: ${conflicted.length}/${WRITERS} transactional ` +
        `attempts saw TransactionConflict; ${controlConflicted.length}/${WRITERS} plain ` +
        `PutItem attempts did`,
    );

    // Existence, not rate: the aggregate 65% this width recorded has no
    // per-round breakdown behind it, so this asserts only that the failure
    // happened at least once, never how often.
    expect(conflicted.length).toBeGreaterThan(0);
    expect(controlConflicted).toHaveLength(0);
  });

  /**
   * (docs/evidence/transaction-conflict-contention.md, E-6) — contention, as a
   * bounded claim rather than a measurement.
   *
   * Under contention the design's shape converts most would-be condition
   * failures into *retryable* conflicts, which the library's existing retry
   * budget is supposed to absorb. What this asserts is that it does: every
   * logical write reaches a clean terminal outcome — one winner, the rest
   * turned away by the condition — and none of them ends in
   * `RetryExhaustedError`.
   *
   * It deliberately does **not** pin the conflict percentage. 38 % / 65 % /
   * 86 % at 2 / 5 / 20 writers is what AWS did on one day in one region (E-5);
   * a test that pins it makes a flaky assertion out of a true observation. The
   * rate is printed so a run still reports it.
   */
  it('E-6: lands every one of five racing writers on a clean terminal outcome', async () => {
    const base = new DynamoDBClient({ ...clientConfig, maxAttempts: 1 });
    const counter = countTransactAttempts(base);
    const deps = { client: DynamoDBDocument.from(base), tableName };
    const guard = revisionGuard('rev', { exists: false });

    const settled = await Promise.allSettled(
      Array.from({ length: WRITERS }, async (_unused, writer) =>
        putIdempotently(deps, { PK: 'l3', SK: 'row', writer: String(writer) }, guard),
      ),
    );
    base.destroy();

    const rate = counter.attempts === 0 ? 0 : (counter.conflicts / counter.attempts) * 100;
    report(
      `E-6 ${WRITERS} writers on one row: ${counter.attempts} attempts, ` +
        `${counter.conflicts} conflicts (${rate.toFixed(0)}%), ` +
        `${(counter.attempts / WRITERS).toFixed(1)} attempts per logical write`,
    );

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of settled) {
      if (result.status === 'fulfilled') continue;
      const error = result.reason as Error;
      // A clean loss: turned away by the condition, not by a spent budget.
      expect(isConditionalCheckFailed(error)).toBe(true);
      expect((error as { code?: string }).code).not.toBe(ErrorCode.RETRY_EXHAUSTED);
    }
    expect(counter.attempts).toBeGreaterThanOrEqual(WRITERS);
  });
});
