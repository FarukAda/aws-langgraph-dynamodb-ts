import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { INITIAL_BACKOFF_DELAY_MS, MAX_UNPROCESSED_RETRIES } from '../constants';
import { BatchWriteIncompleteError } from '../errors/errors';
import { fullJitter, nextBackoffDelay, sleep } from './backoff';
import { withDynamoDBRetry } from './retry';
import type { DocItem, WriteRequest } from './types';

/** Backoff/abort options shared by the drain helpers. */
export interface DrainOptions {
  signal?: AbortSignal;
  rng?: () => number;
  maxRetries?: number;
}

/**
 * Submit `requests` via BatchWriteItem and re-submit UnprocessedItems with
 * full-jitter backoff until the batch drains. Throws
 * {@link BatchWriteIncompleteError} if it cannot drain within the retry budget.
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
    const result = await withDynamoDBRetry(
      () => client.batchWrite({ RequestItems: { [tableName]: pending } }),
      { signal: options.signal },
    );
    const leftover = (result.UnprocessedItems?.[tableName] as WriteRequest[] | undefined) ?? [];
    if (leftover.length === 0) return;
    retries += 1;
    if (retries > maxRetries) {
      throw new BatchWriteIncompleteError(initialCount - leftover.length, leftover, maxRetries);
    }
    await sleep(fullJitter(delay, options.rng), options.signal);
    delay = nextBackoffDelay(delay);
    pending = leftover;
  }
}

/**
 * Fetch `keys` via BatchGetItem and re-request UnprocessedKeys with full-jitter
 * backoff, collecting every returned item. Returns the accumulated items.
 */
export async function drainUnprocessedKeys(
  client: DynamoDBDocument,
  tableName: string,
  keys: DocItem[],
  options: DrainOptions = {},
): Promise<DocItem[]> {
  if (keys.length === 0) return [];
  const maxRetries = options.maxRetries ?? MAX_UNPROCESSED_RETRIES;
  const collected: DocItem[] = [];
  let pending = keys;
  let delay = INITIAL_BACKOFF_DELAY_MS;
  let retries = 0;
  while (pending.length > 0) {
    const result = await withDynamoDBRetry(
      () => client.batchGet({ RequestItems: { [tableName]: { Keys: pending } } }),
      { signal: options.signal },
    );
    collected.push(...((result.Responses?.[tableName] as DocItem[] | undefined) ?? []));
    const leftover = (result.UnprocessedKeys?.[tableName]?.Keys as DocItem[] | undefined) ?? [];
    if (leftover.length === 0) break;
    retries += 1;
    if (retries > maxRetries) break;
    await sleep(fullJitter(delay, options.rng), options.signal);
    delay = nextBackoffDelay(delay);
    pending = leftover;
  }
  return collected;
}
