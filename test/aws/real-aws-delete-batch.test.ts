import { randomBytes, randomUUID } from 'node:crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { type BatchWriteCommandInput, DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { type RejectionFields } from '../../src/shared/dynamodb/cancellation';
import {
  isConditionalCheckFailed,
  rejectedItem,
  writeIdGuard,
} from '../../src/shared/dynamodb/conditional-put';
import { deleteIdempotently } from '../../src/shared/dynamodb/idempotent-write';
import { ErrorCode } from '../../src/shared/errors/error-code';
import { countTransactAttempts, rejection, report } from './helpers/probe';
import { createTestTable } from './helpers/table';
import { deleteTableCompletely, settleAll } from './helpers/teardown';

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
const clientConfig = region ? { region } : {};
const tableName = `aws-langgraph-delbatchtest-${randomUUID()}`;

/** How many deleters race one row in the contention arm. */
const DELETERS = 5;

/** ~300 KB of incompressible text, the size a checkpoint row carrying an inline payload reaches. */
const bigAttribute = randomBytes(220 * 1024).toString('base64');

/**
 * Why the partition delete is one conditional `DeleteItem` per row rather than
 * a `BatchWriteItem`, proved against real AWS: the batch path cannot be made
 * safe at any price, what the per-row path costs instead, and what it meets
 * under contention. Two of these assert claims recorded in `docs/evidence`
 * (E-16, E-17).
 *
 * Creates and tears down one on-demand table per run.
 */
describe('the batch delete path, its cost and its contention, against real AWS', () => {
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
   * (docs/evidence/batch-write-condition.md, E-17) — a `ConditionExpression`
   * on a `BatchWriteItem` `DeleteRequest` is **accepted and silently
   * ignored**: the request succeeds, reports nothing unprocessed, and the row
   * is deleted although the condition was false.
   *
   * This assertion is **defensive, not diagnostic**. It exists so that a future
   * "optimisation" back to a conditional batch — twenty-five rows per request
   * instead of twenty-five requests — fails loudly here instead of silently
   * deleting rows in someone's table. That is why the partition delete cannot
   * be made safe as a batch at any price and has to pay round trips.
   *
   * It says the same thing whichever layer drops the condition: the SDK's
   * `DeleteRequest` shape carries no such field — the request below has to be
   * cast through `unknown` to hold one at all — so the condition may never
   * reach the wire. A guard that is not transmitted and a guard that is ignored
   * are the same danger: the caller wrote a condition and the row went anyway.
   */
  it('E-17: accepts a condition on a batch delete request and deletes the row regardless', async () => {
    const key = { PK: 'd7', SK: 'row' };
    await doc.put({ TableName: tableName, Item: { ...key, rev: 'R1' } });

    const conditioned = {
      RequestItems: {
        [tableName]: [
          {
            DeleteRequest: {
              Key: key,
              ConditionExpression: '#pin = :pin',
              ExpressionAttributeNames: { '#pin': 'rev' },
              ExpressionAttributeValues: { ':pin': 'A-REVISION-THIS-ROW-NEVER-HAD' },
            },
          },
        ],
      },
    } as unknown as BatchWriteCommandInput;
    const response = await doc.batchWrite(conditioned);
    expect(response.UnprocessedItems?.[tableName] ?? []).toHaveLength(0);

    const after = await doc.get({ TableName: tableName, Key: key, ConsistentRead: true });
    expect(after.Item).toBeUndefined();
  });

  /**
   * (docs/evidence/delete-capacity.md, E-16) — what a delete costs, and what a
   * refusal does not report.
   *
   * A successful delete is charged on the size of the row it removes, not on a
   * flat unit, which is why a checkpoint row carrying an inline payload is
   * expensive to delete and why a transaction doubles it. A **refused**
   * conditional delete returns no `ConsumedCapacity` at all, so its charge
   * cannot be observed from the response: any design text pricing a refusal has
   * to cite the documentation rather than a measurement.
   *
   * The number is printed rather than pinned — it is the size of this row on
   * this day, and pinning it would make a flaky test out of a true observation.
   * What is asserted is only the shape: absent on a refusal, and well above one
   * unit on a success.
   */
  it('E-16: reports no consumed capacity for a refusal and row-sized capacity for a success', async () => {
    const key = { PK: 'd6', SK: 'row' };
    await doc.put({ TableName: tableName, Item: { ...key, rev: 'R1', blob: bigAttribute } });

    const refused = await rejection(
      doc.delete({
        TableName: tableName,
        Key: key,
        ReturnConsumedCapacity: 'TOTAL',
        ...writeIdGuard('rev', 'STALE'),
      }),
    );
    expect(refused.name).toBe('ConditionalCheckFailedException');
    expect((refused as { ConsumedCapacity?: object }).ConsumedCapacity).toBeUndefined();

    const removed = await doc.delete({
      TableName: tableName,
      Key: key,
      ReturnConsumedCapacity: 'TOTAL',
      ...writeIdGuard('rev', 'R1'),
    });
    const units = removed.ConsumedCapacity?.CapacityUnits;
    report(`E-16 conditional delete of a ~300 KB row: ${String(units)} capacity unit(s)`);
    expect(units).toBeGreaterThan(1);
  });

  /**
   * The delete-side contention measurement, previously untested on its own —
   * only the write side's had been.
   *
   * Five deleters race one row, each pinned on the revision it observed, each
   * under its own token and the library's own retry budget. The claim is
   * bounded rather than numeric: exactly one wins, every loser reaches a clean
   * terminal outcome, and none ends in `RetryExhaustedError`.
   *
   * The losers' shape is the part worth having. Each one meets a row that the
   * winner has already removed, so each rejection carries **no** row — which is
   * the "already gone" decode arriving in a real race rather than in a
   * constructed probe. A loser that came back carrying a row would mean the
   * pass was about to leave a live row's object released.
   *
   * The rate is printed, not pinned: it is what AWS did on one day in one
   * region.
   */
  it('lands every one of five racing deleters on a clean terminal outcome', async () => {
    const key = { PK: 'contention', SK: 'row' };
    await doc.put({ TableName: tableName, Item: { ...key, rev: 'R1' } });

    const base = new DynamoDBClient({ ...clientConfig, maxAttempts: 1 });
    const counter = countTransactAttempts(base);
    const deps = { client: DynamoDBDocument.from(base), tableName };
    const settled = await Promise.allSettled(
      Array.from({ length: DELETERS }, async () =>
        deleteIdempotently(deps, key, writeIdGuard('rev', 'R1')),
      ),
    );
    base.destroy();

    const rate = counter.attempts === 0 ? 0 : (counter.conflicts / counter.attempts) * 100;
    report(
      `delete-side ${DELETERS} deleters on one row: ${counter.attempts} attempts, ` +
        `${counter.conflicts} conflicts (${rate.toFixed(0)}%), ` +
        `${(counter.attempts / DELETERS).toFixed(1)} attempts per logical delete`,
    );

    expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    for (const result of settled) {
      if (result.status === 'fulfilled') continue;
      const error = result.reason as Error;
      expect(isConditionalCheckFailed(error as RejectionFields)).toBe(true);
      expect((error as { code?: string }).code).not.toBe(ErrorCode.RETRY_EXHAUSTED);
      // Already gone, not rewritten: the loser may release what it read.
      expect(rejectedItem(error)).toBeUndefined();
    }
  });
});
