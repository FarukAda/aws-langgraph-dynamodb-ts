import { randomUUID } from 'node:crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument, type TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';

import {
  conditionalCheckFailure,
  getCancellationReasons,
} from '../../src/shared/dynamodb/cancellation';
import {
  type RevisionGuard,
  rejectedItem,
  writeIdGuard,
} from '../../src/shared/dynamodb/conditional-put';
import { rejection, report } from './helpers/probe';
import { createTestTable } from './helpers/table';
import { deleteTableCompletely, settleAll } from './helpers/teardown';

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
const clientConfig = region ? { region } : {};
const tableName = `aws-langgraph-deltest-${randomUUID()}`;

/** The delete the design sends: one `Delete`, one guard, one token. */
function tokenedDelete(
  token: string,
  key: Record<string, string>,
  guard?: RevisionGuard,
): TransactWriteCommandInput {
  return {
    ClientRequestToken: token,
    TransactItems: [{ Delete: { TableName: tableName, Key: key, ...guard } }],
  };
}

/**
 * The live assertions the **delete** side of the design rests on, each
 * asserting a claim recorded in `docs/evidence` (E-3, E-4, E-13 through E-15),
 * so that they run before every tag rather than living in a markdown file
 * nothing re-checks.
 *
 * The delete side needs live evidence more than the put side does, because its
 * whole safety argument is a *decode*: a refusal carrying a row means "someone
 * rewrote it since I read it, leave it alone", and a refusal carrying no row
 * means "it is already gone, count it deleted and release its object". Read
 * those two backwards and the pass either erases acknowledged writes or
 * releases objects a live row still names. Every assertion here is about which
 * of the two shapes real DynamoDB actually produces.
 *
 * Creates and tears down one on-demand table per run.
 */
describe('the delete-side contract this design rests on, against real AWS', () => {
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
   * (docs/evidence/transactional-delete-idempotency.md, E-13) — the
   * idempotency cache covers a transactional `Delete` exactly as it covers a
   * `Put`.
   *
   * This is the fact the whole delete-side candidate rests on. An
   * unconditional `DeleteItem` cannot be turned away, so a retry arriving
   * after the first attempt already committed removes whatever a competitor
   * has written since. Under a token the replay never reaches the row — which
   * is what the row written *between* the two sends proves here: it survives.
   */
  it('E-13: answers a replayed delete from the cache, leaving a row written since it untouched', async () => {
    const key = { PK: 'd1', SK: 'row' };
    await doc.put({ TableName: tableName, Item: { ...key, rev: 'R1' } });
    const input = tokenedDelete(randomUUID(), key);

    await doc.transactWrite(input);
    await doc.put({ TableName: tableName, Item: { ...key, rev: 'R2', written: 'after' } });
    const replay = await doc.transactWrite(input);
    expect(replay.$metadata.httpStatusCode).toBe(200);

    const after = await doc.get({ TableName: tableName, Key: key, ConsistentRead: true });
    expect(after.Item).toEqual({ ...key, rev: 'R2', written: 'after' });
  });

  /**
   * (docs/evidence/cancelled-transaction-token.md, E-3) — the re-pin refusal,
   * on a `Delete` rather than a `Put`.
   *
   * A cancelled use caches no result but still reserves its parameters, so a
   * compare-and-swap loop that re-pinned onto the revision the rejection just
   * handed it, while re-presenting the token it already spent, would be refused
   * with `IdempotentParameterMismatchException` — a name in no retry list and
   * no handler in this package, so the caller would see a raw SDK error. That
   * is why a re-pin must mint a fresh token, and DynamoDB Local cannot show it:
   * there a cancelled token reserves nothing.
   */
  it('E-3: refuses a cancelled delete token re-sent with the re-pinned body', async () => {
    const key = { PK: 'd2', SK: 'row' };
    await doc.put({ TableName: tableName, Item: { ...key, rev: 'R1' } });
    const token = randomUUID();

    const refused = await rejection(
      doc.transactWrite(tokenedDelete(token, key, writeIdGuard('rev', 'STALE'))),
    );
    expect(refused.name).toBe('TransactionCanceledException');

    const repinned = tokenedDelete(token, key, writeIdGuard('rev', 'R1'));
    const mismatch = await rejection(doc.transactWrite(repinned));
    expect(mismatch.name).toBe('IdempotentParameterMismatchException');

    const after = await doc.get({ TableName: tableName, Key: key, ConsistentRead: true });
    expect(after.Item).toBeDefined();
  });

  /**
   * (docs/evidence/transaction-rejected-row.md, E-4) — a refused transactional
   * delete returns the row it refused, raw, which is what lets the loop re-pin
   * rather than give up.
   *
   * The second half is the one that matters: the same delete, re-pinned from
   * the rejected row onto the revision it actually carries and carrying a
   * **fresh** token, succeeds. Together with the refusal above that is the
   * whole rule: the body may change, the token may not be reused.
   */
  it('E-4: hands back the rejected row raw, and a fresh token re-pinned from it succeeds', async () => {
    const key = { PK: 'd3', SK: 'row' };
    const row = { ...key, rev: 'R1', note: 'x', v: 7 };
    await doc.put({ TableName: tableName, Item: row });

    const refused = await rejection(
      doc.transactWrite(tokenedDelete(randomUUID(), key, writeIdGuard('rev', 'STALE'))),
    );
    const reason = conditionalCheckFailure(refused);
    expect(reason?.Code).toBe('ConditionalCheckFailed');
    expect(reason?.Item?.rev).toEqual({ S: 'R1' });
    expect(reason?.Item?.v).toEqual({ N: '7' });
    expect(rejectedItem(refused)).toEqual(row);

    const observed = String(rejectedItem(refused)?.rev);
    await doc.transactWrite(tokenedDelete(randomUUID(), key, writeIdGuard('rev', observed)));
    const after = await doc.get({ TableName: tableName, Key: key, ConsistentRead: true });
    expect(after.Item).toBeUndefined();
  });

  /**
   * (docs/evidence/conditional-delete.md, E-14) — a conditional `DeleteItem`
   * against a row that is already gone rejects with **no** `Item`.
   *
   * This is the decode the whole partition delete turns on: no item means the
   * row is already gone, so count it deleted and release the object it named;
   * an item means it was rewritten since the read, so leave it. The two cases
   * have to be distinguishable from the rejection alone, because a second read
   * to tell them apart would race the same writer all over again.
   */
  it('E-14: rejects a conditional delete of an absent row without attaching an item', async () => {
    const refused = await rejection(
      doc.delete({
        TableName: tableName,
        Key: { PK: 'd4', SK: 'never-written' },
        ...writeIdGuard('rev', 'R1'),
      }),
    );
    expect(refused.name).toBe('ConditionalCheckFailedException');
    expect((refused as { Item?: object }).Item).toBeUndefined();
    expect(rejectedItem(refused)).toBeUndefined();
  });

  /**
   * The *transactional* form of the same rejection against an **absent**
   * row (E-14 above is the plain, non-transactional form).
   *
   * A transaction reports the rejection as one cancellation *reason* rather
   * than as an exception of its own, so nothing about the plain `DeleteItem`
   * shape settles this on its own — it needs its own live check. The whole
   * reason shape is printed, so a run reports what it actually is rather than
   * only whether it matched.
   */
  it('settles the transactional absent-row rejection shape: one reason, no item', async () => {
    const refused = await rejection(
      doc.transactWrite(
        tokenedDelete(randomUUID(), { PK: 'd-absent', SK: 'row' }, writeIdGuard('rev', 'R1')),
      ),
    );
    expect(refused.name).toBe('TransactionCanceledException');

    const reasons = getCancellationReasons(refused) ?? [];
    report(`transactional delete of an absent row: ${JSON.stringify(reasons)}`);
    expect(reasons).toHaveLength(1);
    expect(reasons[0].Code).toBe('ConditionalCheckFailed');
    expect(reasons[0].Item).toBeUndefined();
    expect(rejectedItem(refused)).toBeUndefined();
  });

  /**
   * (docs/evidence/conditional-delete.md, E-15) — the inner miss.
   *
   * The guard is a document path over a payload descriptor (`#pin.#field`).
   * E-14 covers only the case where the row is entirely absent; this covers
   * two narrower cases the mechanism also meets: the *outer* attribute absent
   * on a row that otherwise exists, and the attribute present but carrying no
   * id inside it — what a concurrent writer leaves when it rewrites a row from
   * offloaded to inline. Both evaluate to **false** rather than raising
   * `ValidationException`, so one condition shape covers an offloaded row, an
   * inline one, and a row a racer has turned into either.
   *
   * Read what this does *not* say. It is not "a row with no id is refused": the
   * condition is only ever sent for a row the partition query observed carrying
   * one. A row observed *without* an id — every row written before this guard
   * existed — is deleted unconditionally, because refusing those would leave
   * that data undeletable, an availability regression far worse than the
   * erasure being closed.
   */
  it('E-15: evaluates a document-path guard as false for an inner miss, and returns the row', async () => {
    const guard = writeIdGuard('value', 'W1', 'writeId');
    const matching = { PK: 'b1', SK: 'matching', value: { writeId: 'W1', location: 'S3' } };
    const innerMiss = { PK: 'b1', SK: 'inner-miss', value: { location: 'S3' } };
    const noAttribute = { PK: 'b1', SK: 'no-attribute', note: 'inline, rc.1 shaped' };
    for (const item of [matching, innerMiss, noAttribute]) {
      await doc.put({ TableName: tableName, Item: item });
    }

    await doc.delete({ TableName: tableName, Key: { PK: 'b1', SK: 'matching' }, ...guard });
    const gone = await doc.get({
      TableName: tableName,
      Key: { PK: 'b1', SK: 'matching' },
      ConsistentRead: true,
    });
    expect(gone.Item).toBeUndefined();

    for (const row of [innerMiss, noAttribute]) {
      const refused = await rejection(
        doc.delete({ TableName: tableName, Key: { PK: row.PK, SK: row.SK }, ...guard }),
      );
      // Not a ValidationException: one condition shape covers every row kind.
      expect(refused.name).toBe('ConditionalCheckFailedException');
      // And the refusal still carries the row, so the "already gone" versus
      // "rewritten since the read" decode above holds for the inner miss too.
      expect(rejectedItem(refused)).toEqual(row);
    }
  });
});
