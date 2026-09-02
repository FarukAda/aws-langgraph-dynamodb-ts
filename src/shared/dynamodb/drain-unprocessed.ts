import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { INITIAL_BACKOFF_DELAY_MS, MAX_UNPROCESSED_RETRIES } from '../constants';
import { BatchWriteIncompleteError } from '../errors/errors';
import { fullJitter, nextBackoffDelay, sleep } from './backoff';
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
 * Submit `requests` via BatchWriteItem and re-submit UnprocessedItems with
 * full-jitter backoff until the batch drains. Throws
 * {@link BatchWriteIncompleteError} if it cannot drain within the retry budget,
 * or if a round's write call or backoff wait throws outright (SDK failure, or
 * the caller's signal aborting) — in every case `succeededCount` reflects
 * every earlier round's confirmed persists, and the triggering error is
 * attached as `cause`.
 */
export async function drainUnprocessedWrites(
  client: DynamoDBDocument,
  tableName: string,
  requests: WriteRequest[],
  options: DrainOptions = {},
): Promise<void> {
  if (requests.length === 0) return;
  const maxRetries = options.maxRetries ?? MAX_UNPROCESSED_RETRIES;
  const initialCount = requests.length;
  let pending = requests;
  let delay = INITIAL_BACKOFF_DELAY_MS;
  let retries = 0;
  while (pending.length > 0) {
    try {
      const result = await withDynamoDBRetry(
        () => client.batchWrite({ RequestItems: { [tableName]: pending } }),
        { ...options.retry, signal: options.signal },
      );
      const leftover = (result.UnprocessedItems?.[tableName] as WriteRequest[] | undefined) ?? [];
      if (leftover.length === 0) return;
      pending = leftover;
      retries += 1;
      if (retries > maxRetries) break;
      await sleep(fullJitter(delay, options.rng), options.signal);
      delay = nextBackoffDelay(delay);
    } catch (error) {
      throw new BatchWriteIncompleteError(
        initialCount - pending.length,
        pending,
        retries,
        error as Error,
      );
    }
  }
  throw new BatchWriteIncompleteError(initialCount - pending.length, pending, maxRetries);
}
