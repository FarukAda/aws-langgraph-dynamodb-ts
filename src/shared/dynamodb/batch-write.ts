import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { BATCH_WRITE_MAX } from '../constants';
import { ErrorCode } from '../errors/error-code';
import { BatchWriteAllIncompleteError, BatchWriteIncompleteError } from '../errors/errors';
import { DrainOptions, drainUnprocessedWrites } from './drain-unprocessed';
import type { WriteRequest } from './types';

/**
 * Whether a chunk's failure is the drain's incomplete-batch error, the only one
 * carrying a count this function may add to its own total. The drain's other
 * documented throw is an `AbortError`, which carries none.
 */
function isBatchWriteIncomplete(error: Error): error is BatchWriteIncompleteError {
  return (error as { code?: string }).code === ErrorCode.BATCH_WRITE_INCOMPLETE;
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
 * Accepts: `requests` — any number, in any order, of writes that do not depend
 * on each other; none is a no-op. `options` — the drain's retry budget and
 * signal.
 *
 * Returns: nothing, and only when every request persisted.
 *
 * Throws: `AbortError` the moment a chunk reports one, unwrapped and with no
 * further chunk attempted — a caller who cancelled did not encounter a fault,
 * and spending the remaining requests on a cancelled call is the opposite of
 * what the cancel asked for. Otherwise {@link BatchWriteAllIncompleteError},
 * once every chunk has been attempted, reporting how many chunks succeeded and
 * how many individual writes persisted. Its one caller — the rollback in
 * history/internal/compensation.ts — type-asserts a caught error straight to
 * that type (not `instanceof`, banned repo-wide) instead of narrowing it, on
 * the narrower guarantee that it passes no signal, so the abort path cannot
 * arise there; a call site that does pass one must narrow instead.
 *
 * Guarantees: every chunk is attempted regardless of an earlier chunk's
 * failure — these writes are order-independent, so losing the later ones to an
 * earlier failure would delete less than the caller asked and report no more
 * for it. A cancel is the one exception, because it is not a failure. The
 * count the error carries is exact, which is what lets a compensating caller
 * revert precisely what landed, and it never counts a chunk whose error
 * carried no count of its own.
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
      const failure = error as Error;
      /**
       * Anything but an incomplete batch is the drain's other documented
       * throw, a cancel, and it leaves the loop at once. Reading the code
       * rather than the class is the same realm-safe test the rest of this
       * package makes, and it is what keeps a count this function cannot know
       * out of the total: adding an absent `succeededCount` made it `NaN`.
       */
      if (!isBatchWriteIncomplete(failure)) throw failure;
      failedChunks.push(failure);
      succeededCount += failure.succeededCount;
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
