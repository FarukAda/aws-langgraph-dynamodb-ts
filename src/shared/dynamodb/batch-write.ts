/**
 * Hides BatchWriteItem.
 *
 * A call carries at most twenty-five requests, and the service may hand some
 * back unprocessed; they are re-sent with backoff until a bound, and a batch
 * that still cannot finish is reported with how much of it did.
 */

import {
  BATCH_WRITE_MAX,
  INITIAL_BACKOFF_DELAY_MS,
  MAX_BACKOFF_DELAY_MS,
  MAX_UNPROCESSED_RETRIES,
} from '../constants';
import { hasErrorCode } from '../errors/base-error';
import { ErrorCode } from '../errors/error-code';
import { batchWriteAllIncompleteError, batchWriteIncompleteError } from '../errors/errors';
import { isAbortError } from './abort';
import type { DynamoDBDocumentLike, WriteRequest } from './client';
import { fullJitter, nextBackoffDelay, sleep, type RetryOptions, withDynamoDBRetry } from './retry';

/**
 * Write an arbitrary number of requests, chunked into batches of 25 (the
 * BatchWriteItem limit). Every chunk is attempted regardless of an earlier
 * chunk's failure — order-independent writes (deletes/puts) should never
 * lose "later" chunks just because an earlier one failed. If any chunk fails,
 * throws `BATCH_WRITE_INCOMPLETE` reporting exactly how many
 * chunks succeeded vs. failed, and exactly how many individual writes
 * persisted, once every chunk has been attempted.
 *
 * Accepts: `requests` — any number, in any order, of writes that do not depend
 * on each other; none is a no-op. `options` — the drain's retry budget and
 * signal.
 *
 * Returns: nothing, and only when every request persisted.
 *
 * Throws: `ABORTED` the moment a chunk reports one, unwrapped and with no
 * further chunk attempted — a caller who cancelled did not encounter a fault,
 * and spending the remaining requests on a cancelled call is the opposite of
 * what the cancel asked for. Otherwise `BATCH_WRITE_INCOMPLETE`,
 * once every chunk has been attempted, reporting how many chunks succeeded and
 * how many individual writes persisted. Its one caller — the rollback in
 * history/internal/append.ts — type-asserts a caught error straight to
 * its code's details (not `instanceof`, banned repo-wide) instead of
 * narrowing it, on the narrower guarantee that it passes no signal, so the
 * abort path cannot arise there; a call site that does pass one must narrow
 * instead.
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
  client: DynamoDBDocumentLike,
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
       * throw, a cancel, and it leaves the loop at once. Reading the brand and
       * code rather than the class is the same realm-safe test the rest of
       * this package makes, and it is what keeps a count this function cannot
       * know out of the total: adding an absent `succeededCount` made it
       * `NaN`.
       */
      if (!hasErrorCode(failure, ErrorCode.BATCH_WRITE_INCOMPLETE)) throw failure;
      failedChunks.push(failure);
      succeededCount += failure.details.succeededCount;
    }
  }
  if (failedChunks.length > 0) {
    throw batchWriteAllIncompleteError(succeededChunks, totalChunks, failedChunks, succeededCount);
  }
}

/** Backoff/abort options shared by the drain helpers. */
export interface DrainOptions {
  /** The adapter's retry options, applied to every BatchWriteItem round. */
  retry?: RetryOptions;
  signal?: AbortSignal;
  rng?: () => number;
  maxRetries?: number;
}

/**
 * The backoff window between rounds: the adapter's configured policy, never
 * module constants. Reading the constants here meant a caller raising
 * `baseDelayMs` still got 100 ms on this one path, so the documented "one
 * policy governs every wait" held everywhere except the drain.
 */
function drainBackoff(retry?: RetryOptions): { base: number; max: number } {
  return {
    base: retry?.baseDelayMs ?? INITIAL_BACKOFF_DELAY_MS,
    max: retry?.maxDelayMs ?? MAX_BACKOFF_DELAY_MS,
  };
}

/**
 * The error a failed round raises.
 *
 * An `ABORTED` error passes through unchanged: a caller who cancelled did not get
 * an incomplete batch write, and wrapping it reported
 * `BATCH_WRITE_INCOMPLETE` for an aborted `deleteThread`, contradicting the
 * `ABORTED` every cancellable method documents. Anything else becomes a
 * `BATCH_WRITE_INCOMPLETE` error carrying what did persist.
 */
function drainFailure(
  error: Error,
  succeededCount: number,
  pending: WriteRequest[],
  retries: number,
): Error {
  if (isAbortError(error)) return error;
  return batchWriteIncompleteError(succeededCount, pending, retries, error);
}

/**
 * Write `requests` with `BatchWriteItem`, re-submitting what DynamoDB returns
 * as `UnprocessedItems` until the batch drains.
 *
 * Accepts: `requests` — any length, including empty, which issues no request.
 * `options.maxRetries` — re-submission rounds, default
 * {@link MAX_UNPROCESSED_RETRIES}. `options.retry` — the adapter's policy, whose
 * `baseDelayMs` and `maxDelayMs` set the backoff between rounds, so one policy
 * governs every wait this package performs. `options.signal` — aborts a wait.
 *
 * Returns: nothing; success means every request persisted.
 *
 * Throws: `BATCH_WRITE_INCOMPLETE` when the batch does not drain
 * within the rounds allowed, or when a round's write call fails outright — its
 * `succeededCount` is every earlier round's confirmed persists and the
 * triggering error is the `cause`. An `ABORTED` error passes through unchanged: a
 * caller who cancelled did not get an incomplete batch write, and every
 * cancellable method documents `ABORTED`.
 *
 * Guarantees: **every** error this function throws is one of those two — a
 * `BATCH_WRITE_INCOMPLETE` error carrying an accurate `succeededCount`, or an
 * `ABORTED` error. {@link batchWriteAll} adds up those counts across chunks and
 * depends on it.
 */
export async function drainUnprocessedWrites(
  client: DynamoDBDocumentLike,
  tableName: string,
  requests: WriteRequest[],
  options: DrainOptions = {},
): Promise<void> {
  if (requests.length === 0) return;
  const maxRetries = options.maxRetries ?? MAX_UNPROCESSED_RETRIES;
  const initialCount = requests.length;
  const { base: baseDelay, max: maxDelay } = drainBackoff(options.retry);
  let pending = requests;
  let delay = baseDelay;
  let retries = 0;
  while (pending.length > 0) {
    try {
      const result = await withDynamoDBRetry(
        (request) => client.batchWrite({ RequestItems: { [tableName]: pending } }, request),
        { ...options.retry, signal: options.signal },
      );
      const leftover = (result.UnprocessedItems?.[tableName] as WriteRequest[] | undefined) ?? [];
      if (leftover.length === 0) return;
      pending = leftover;
      retries += 1;
      if (retries > maxRetries) break;
      await sleep(fullJitter(delay, options.rng), options.signal);
      delay = nextBackoffDelay(delay, maxDelay);
    } catch (error) {
      throw drainFailure(error as Error, initialCount - pending.length, pending, retries);
    }
  }
  throw batchWriteIncompleteError(initialCount - pending.length, pending, maxRetries);
}
