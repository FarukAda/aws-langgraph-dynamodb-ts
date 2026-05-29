/**
 * Unit tests for src/shared/utils/batch-write.ts
 *
 * Pinned against real source:
 *  - BATCH_WRITE_MAX = 25 chunking in batchWriteAllWithRetry
 *  - UnprocessedItems retry resubmits ONLY the residual items
 *  - MAX_UNPROCESSED_RETRIES = 10 -> exhaustion throws BatchWriteIncompleteError
 *    after 11 BatchWrite calls (1 initial + 10 retries) with the exact name,
 *    succeededCount, unprocessed array, and message text from source.
 *  - empty input issues zero DDB calls (early return).
 *
 * AWS mocked via aws-sdk-client-mock only (REQ-2). Backoff between retries uses
 * real setTimeout in source; we install fake timers locally and drain them so
 * the exhaustion path runs deterministically and fast.
 */
import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

import { BatchWriteIncompleteError } from '../../../../src/index';
import {
  batchWriteWithRetry,
  batchWriteAllWithRetry,
} from '../../../../src/shared/utils/batch-write';
import { MAX_UNPROCESSED_RETRIES, BATCH_WRITE_MAX } from '../../../../src/shared/utils/constants';
import { createStrictDdbMock, type StrictDdbMock } from '../../../shared/mocks/dynamodb';

const TABLE = 'test-table';

/** Build N PutRequest write items deterministically. */
function makeWriteItems(n: number): Array<{ PutRequest: { Item: { id: string } } }> {
  return Array.from({ length: n }, (_v, i) => ({ PutRequest: { Item: { id: `id-${i}` } } }));
}

/**
 * Run a promise to completion while repeatedly flushing pending fake timers.
 * The source awaits `sleep(...)` (real setTimeout) between retries; under fake
 * timers each setTimeout must be advanced for the loop to progress.
 */
async function runWithTimerDrain<T>(p: Promise<T>): Promise<T> {
  let settled = false;
  const wrapped = p.finally(() => {
    settled = true;
  });
  // Advance timers in a microtask-yielding loop until the promise settles.
  while (!settled) {
    await Promise.resolve();
    jest.advanceTimersByTime(60_000);
  }
  return wrapped;
}

describe('batch-write', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  describe('chunking at the BATCH_WRITE_MAX (25) limit', () => {
    it('splits 26 write items into two BatchWriteCommand calls of exactly 25 and 1', async () => {
      const items = makeWriteItems(26);
      ddb.mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

      await batchWriteAllWithRetry(ddb.mock as never, TABLE, items);

      const calls = ddb.mock.commandCalls(BatchWriteCommand);
      expect(calls).toHaveLength(2);
      expect(calls[0].args[0].input).toEqual({
        RequestItems: { [TABLE]: items.slice(0, BATCH_WRITE_MAX) },
      });
      expect(calls[1].args[0].input).toEqual({
        RequestItems: { [TABLE]: items.slice(BATCH_WRITE_MAX, 26) },
      });
    }); // AC-7

    it('sends a single BatchWriteCommand of exactly 25 items at the boundary', async () => {
      const items = makeWriteItems(BATCH_WRITE_MAX);
      ddb.mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

      await batchWriteAllWithRetry(ddb.mock as never, TABLE, items);

      const calls = ddb.mock.commandCalls(BatchWriteCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toEqual({ RequestItems: { [TABLE]: items } });
    }); // AC-7

    it('issues zero BatchWriteCommand calls for an empty request list (early return)', async () => {
      await batchWriteAllWithRetry(ddb.mock as never, TABLE, []);
      await batchWriteWithRetry(ddb.mock as never, TABLE, []);

      expect(ddb.mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
    }); // AC-7
  });

  describe('UnprocessedItems retry', () => {
    it('resubmits only the unprocessed items on a partial response then succeeds', async () => {
      jest.useFakeTimers();
      try {
        const items = makeWriteItems(2);
        ddb.mock
          .on(BatchWriteCommand)
          .resolvesOnce({ UnprocessedItems: { [TABLE]: [items[1]] } })
          .resolvesOnce({ UnprocessedItems: {} });

        await runWithTimerDrain(batchWriteWithRetry(ddb.mock as never, TABLE, items));

        const calls = ddb.mock.commandCalls(BatchWriteCommand);
        expect(calls).toHaveLength(2);
        // First attempt carries both items.
        expect(calls[0].args[0].input).toEqual({ RequestItems: { [TABLE]: items } });
        // Second attempt carries ONLY the previously-unprocessed item.
        expect(calls[1].args[0].input).toEqual({ RequestItems: { [TABLE]: [items[1]] } });
      } finally {
        jest.useRealTimers();
      }
    }); // AC-7

    it('returns without retrying when the first response drains all items', async () => {
      const items = makeWriteItems(3);
      ddb.mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });

      await batchWriteWithRetry(ddb.mock as never, TABLE, items);

      const calls = ddb.mock.commandCalls(BatchWriteCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0].args[0].input).toEqual({ RequestItems: { [TABLE]: items } });
    }); // AC-7
  });

  describe('BatchWriteIncompleteError on exhaustion', () => {
    it('throws BatchWriteIncompleteError after MAX_UNPROCESSED_RETRIES+1 attempts with exact name/counts/message', async () => {
      jest.useFakeTimers();
      try {
        const items = makeWriteItems(2);
        // Never drains: always one item left unprocessed.
        ddb.mock.on(BatchWriteCommand).resolves({ UnprocessedItems: { [TABLE]: [items[1]] } });

        const err = await runWithTimerDrain(
          batchWriteWithRetry(ddb.mock as never, TABLE, items).catch((e: unknown) => e),
        );

        expect(err).toBeInstanceOf(BatchWriteIncompleteError);
        const incomplete = err as BatchWriteIncompleteError;
        expect(incomplete.name).toBe('BatchWriteIncompleteError');
        // initialCount (2) - unprocessed.length (1) === 1 persisted.
        expect(incomplete.succeededCount).toBe(1);
        expect(incomplete.unprocessed).toEqual([items[1]]);
        expect(incomplete.message).toBe(
          `batchWrite did not drain after ${MAX_UNPROCESSED_RETRIES} UnprocessedItems retries: ` +
            `1 item(s) persisted, 1 still un-acked. ` +
            `Inspect err.unprocessed to drive reconciliation.`,
        );
        // 1 initial attempt + MAX_UNPROCESSED_RETRIES follow-ups, then throw.
        expect(ddb.mock.commandCalls(BatchWriteCommand)).toHaveLength(MAX_UNPROCESSED_RETRIES + 1);
      } finally {
        jest.useRealTimers();
      }
    }); // AC-8

    it('resends an identical RequestItems shape on each unprocessed retry attempt', async () => {
      jest.useFakeTimers();
      try {
        const items = makeWriteItems(1);
        // Single item never drains -> every attempt resends that same item.
        ddb.mock.on(BatchWriteCommand).resolves({ UnprocessedItems: { [TABLE]: items } });

        await runWithTimerDrain(
          batchWriteWithRetry(ddb.mock as never, TABLE, items).catch(() => undefined),
        );

        const calls = ddb.mock.commandCalls(BatchWriteCommand);
        expect(calls).toHaveLength(MAX_UNPROCESSED_RETRIES + 1);
        for (const call of calls) {
          expect(call.args[0].input).toEqual({ RequestItems: { [TABLE]: items } });
        }
      } finally {
        jest.useRealTimers();
      }
    }); // AC-8
  });
});
