import { randomUUID } from 'node:crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';

import {
  conditionalCheckFailure,
  type RejectionFields,
} from '../../src/shared/dynamodb/cancellation';
import {
  isConditionalCheckFailed,
  rejectedItem,
  revisionGuard,
} from '../../src/shared/dynamodb/conditional-put';
import { putIdempotently } from '../../src/shared/dynamodb/idempotent-write';
import { ErrorCode } from '../../src/shared/errors/error-code';
import { countTransactAttempts, report, rejection } from './helpers/probe';
import { createTestTable } from './helpers/table';
import { deleteTableCompletely, settleAll } from './helpers/teardown';

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
const clientConfig = region ? { region } : {};
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
 * on (design §8.3, L1–L4 and L8), ported from the one-off probes recorded in
 * `live-validation.md` on 2026-09-17 so that they run before every tag instead
 * of living in a markdown file that nothing re-checks.
 *
 * None of these can be carried by DynamoDB Local, and L8 least of all: there a
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
   * L1 (`live-validation.md` §1, "VERDICT L1: REPLAY SUPPRESSED") — the one
   * assertion the whole prevention layer rests on, and the reason every other
   * assertion in this file is interpretable at all.
   *
   * The library uploads an object, then commits the row that names it. If a
   * re-sent write could land a second time, the cleanup that follows a lost
   * acknowledgement would release an object the other attempt's row still
   * names, and the checkpoint would become permanently unreadable. Deleting the
   * row between the two sends is what makes this a real test: a replay that was
   * genuinely re-evaluated would recreate it.
   */
  it('L1: answers a replayed completed token from the cache and writes nothing', async () => {
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
   * L2 (`live-validation.md` §1) — a cancelled token caches no result.
   *
   * The replay does not merely fail again: the blocker is gone by then, so
   * re-evaluation succeeds and writes the row. That is the strongest possible
   * form of "not cached", and it is what makes the exactly-once sentence this
   * release ships precise — a write whose first attempt was *rejected* carries
   * no idempotency at all, and its retry is a fresh evaluation against the
   * table as it stands at retry time.
   */
  it('L2: re-evaluates and applies a replayed cancelled token once the blocker is gone', async () => {
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
   * L8 (`live-validation.md` §1, L2c) — the re-pin refusal, and **the one
   * assertion in this repository that only real AWS can make**.
   *
   * A cancelled use caches no result but still reserves its *parameters*, so
   * the same token presented with a changed body inside the ten-minute window
   * is refused with `IdempotentParameterMismatchException` — a name that is in
   * no retry list and in no handler in this package, so a helper that reused a
   * token across a compare-and-swap re-pin would surface a raw SDK error to a
   * caller. This is what makes the design's "a re-pin draws a fresh token" rule
   * necessary rather than merely tidy.
   *
   * Do not move this into the integration tier and do not "simplify" it into
   * L1. DynamoDB Local does not reserve a cancelled token's parameters
   * (`local-validation.md` Probe 3) and simply re-evaluates the changed body,
   * so the assertion silently inverts there. And a re-send of an *identical*
   * request proves L1, not this: the mismatch needs the same token with
   * different parameters, which is the adjacent mistake.
   */
  it('L8: refuses a cancelled token re-sent with a changed body', async () => {
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
   * L4 (`live-validation.md` §2) — the cancellation's `Item` is raw.
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
  it('L4: attaches the rejected row as raw attribute values, exactly as a PutCommand does', async () => {
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
    const reason = conditionalCheckFailure(cancelled as RejectionFields);
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
   * L3 (`live-validation.md` §3) — contention, as a bounded claim rather than a
   * measurement.
   *
   * Under contention the design's shape converts most would-be condition
   * failures into *retryable* conflicts, which the library's existing retry
   * budget is supposed to absorb. What this asserts is that it does: every
   * logical write reaches a clean terminal outcome — one winner, the rest
   * turned away by the condition — and none of them ends in
   * `RetryExhaustedError`.
   *
   * It deliberately does **not** pin the conflict percentage. 38 % / 65 % /
   * 86 % at 2 / 5 / 20 writers is what AWS did on one day in one region; a test
   * that pins it makes a flaky assertion out of a true observation. The rate is
   * printed so a run still reports it.
   */
  it('L3: lands every one of five racing writers on a clean terminal outcome', async () => {
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
      `L3 ${WRITERS} writers on one row: ${counter.attempts} attempts, ` +
        `${counter.conflicts} conflicts (${rate.toFixed(0)}%), ` +
        `${(counter.attempts / WRITERS).toFixed(1)} attempts per logical write`,
    );

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of settled) {
      if (result.status === 'fulfilled') continue;
      const error = result.reason as Error;
      // A clean loss: turned away by the condition, not by a spent budget.
      expect(isConditionalCheckFailed(error as RejectionFields)).toBe(true);
      expect((error as { code?: string }).code).not.toBe(ErrorCode.RETRY_EXHAUSTED);
    }
    expect(counter.attempts).toBeGreaterThanOrEqual(WRITERS);
  });
});
