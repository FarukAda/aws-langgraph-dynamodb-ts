import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { BATCH_WRITE_MAX } from '../constants';
import { BatchWriteAllIncompleteError, BatchWriteIncompleteError } from '../errors/errors';
import { DrainOptions, drainUnprocessedWrites } from './drain-unprocessed';
import type { WriteRequest } from './types';

/** True when `error` is a {@link BatchWriteIncompleteError} — checked by name, not `instanceof`. */
function isBatchWriteIncomplete(error: Error): error is BatchWriteIncompleteError {
  return error.name === 'BatchWriteIncompleteError';
}

/**
 * Write an arbitrary number of requests, chunked into batches of 25 (the
 * BatchWriteItem limit). Every chunk is attempted regardless of an earlier
 * chunk's failure — order-independent writes (deletes/puts) should never
 * lose "later" chunks just because an earlier one failed. If any chunk fails,
 * throws {@link BatchWriteAllIncompleteError} reporting exactly how many
 * chunks succeeded vs. failed, and exactly how many individual writes
 * persisted, once every chunk has been attempted.
 *
 * This is this function's ONLY throw site. Two callers —
 * checkpointer/internal/special-write-cleanup.ts and
 * history/internal/append-saga.ts — type-assert a caught error straight to
 * {@link BatchWriteAllIncompleteError} on that guarantee (not `instanceof`,
 * banned repo-wide) instead of narrowing it, since this project enforces
 * 100% branch coverage and a defensive else-branch here would be
 * unreachable, hence untestable. Adding another throw path to this function
 * requires updating both call sites.
 */
export async function batchWriteAll(
  client: DynamoDBDocument,
  tableName: string,
  requests: WriteRequest[],
  options: DrainOptions = {},
): Promise<void> {
  const totalChunks = Math.ceil(requests.length / BATCH_WRITE_MAX);
  let succeededChunks = 0;
  let succeededCount = 0;
  const failedChunks: Error[] = [];
  for (let offset = 0; offset < requests.length; offset += BATCH_WRITE_MAX) {
    const chunk = requests.slice(offset, offset + BATCH_WRITE_MAX);
    try {
      await drainUnprocessedWrites(client, tableName, chunk, options);
      succeededChunks += 1;
      succeededCount += chunk.length;
    } catch (error) {
      const err = error as Error;
      failedChunks.push(err);
      if (isBatchWriteIncomplete(err)) succeededCount += err.succeededCount;
    }
  }
  if (failedChunks.length > 0) {
    throw new BatchWriteAllIncompleteError(
      succeededChunks,
      totalChunks,
      failedChunks,
      succeededCount,
    );
  }
}
