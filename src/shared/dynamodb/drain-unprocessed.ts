import {
  INITIAL_BACKOFF_DELAY_MS,
  MAX_BACKOFF_DELAY_MS,
  MAX_UNPROCESSED_RETRIES,
} from '../constants';
import { BatchWriteIncompleteError } from '../errors/errors';
import { isAbortError } from './abort';
import { fullJitter, nextBackoffDelay, sleep } from './backoff';
import type { DynamoDBDocumentLike } from './client-types';
import { type RetryOptions, withDynamoDBRetry } from './retry';
import type { WriteRequest } from './types';

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
 * An `AbortError` passes through unchanged: a caller who cancelled did not get
 * an incomplete batch write, and wrapping it reported
 * `BATCH_WRITE_INCOMPLETE` for an aborted `deleteThread`, contradicting the
 * `ABORTED` every cancellable method documents. Anything else becomes a
 * {@link BatchWriteIncompleteError} carrying what did persist.
 */
function drainFailure(
  error: Error,
  succeededCount: number,
  pending: WriteRequest[],
  retries: number,
): Error {
  if (isAbortError(error)) return error;
  return new BatchWriteIncompleteError(succeededCount, pending, retries, error);
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
 * Throws: {@link BatchWriteIncompleteError} when the batch does not drain
 * within the rounds allowed, or when a round's write call fails outright — its
 * `succeededCount` is every earlier round's confirmed persists and the
 * triggering error is the `cause`. An `AbortError` passes through unchanged: a
 * caller who cancelled did not get an incomplete batch write, and every
 * cancellable method documents `ABORTED`.
 *
 * Guarantees: **every** error this function throws is one of those two — a
 * `BatchWriteIncompleteError` carrying an accurate `succeededCount`, or an
 * `AbortError`. {@link batchWriteAll} adds up those counts across chunks and
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
  throw new BatchWriteIncompleteError(initialCount - pending.length, pending, maxRetries);
}
