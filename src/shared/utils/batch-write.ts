/**
 * Shared batch write utilities with UnprocessedItems retry logic
 * Eliminates duplication of the retry pattern across checkpointer, store, and history modules
 */

import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { MAX_UNPROCESSED_RETRIES, BATCH_WRITE_MAX } from './constants';
import { withDynamoDBRetry } from './retry';
import { INITIAL_BACKOFF_DELAY_MS, fullJitter, nextBackoffDelay, sleep } from './sleep';

interface PutWriteRequest {
  PutRequest: { Item: object };
}

interface DeleteWriteRequest {
  DeleteRequest: { Key: object };
}

type WriteRequest = PutWriteRequest | DeleteWriteRequest;

/**
 * Error thrown when `batchWriteWithRetry` / `batchWriteAllWithRetry` exhaust
 * their UnprocessedItems retry budget. Carries enough information for the
 * caller to reason about recovery: how many items persisted before the giveup,
 * how many are still un-acked, and which items remained un-acked.
 *
 * *Partial-success semantics:* DynamoDB's BatchWriteItem is not atomic across
 * items in a batch, and `batchWriteAllWithRetry` issues a sequence of 25-item
 * batches. When this error is thrown, any item not listed in `unprocessed` has
 * already been acked by DynamoDB. Callers that need all-or-nothing must drive
 * reconciliation from `unprocessed` (retry, compensating delete, or surface to
 * the user) — this helper cannot roll back the successful rows for you.
 */
export class BatchWriteIncompleteError extends Error {
  readonly succeededCount: number;
  readonly unprocessed: WriteRequest[];

  constructor(succeededCount: number, unprocessed: WriteRequest[], retries: number) {
    super(
      `batchWrite did not drain after ${retries} UnprocessedItems retries: ` +
        `${succeededCount} item(s) persisted, ${unprocessed.length} still un-acked. ` +
        `Inspect err.unprocessed to drive reconciliation.`,
    );
    this.name = 'BatchWriteIncompleteError';
    this.succeededCount = succeededCount;
    this.unprocessed = unprocessed;
  }
}

export interface BatchWriteOptions {
  /** Optional AbortSignal — short-circuits retry backoff and rejects with the abort reason. */
  signal?: AbortSignal;
}

/**
 * Execute a single batchWrite call with exponential backoff retry for UnprocessedItems.
 *
 * @remarks
 * On exhaustion of the UnprocessedItems retry budget this throws a
 * {@link BatchWriteIncompleteError} that carries the un-acked items — items
 * NOT listed there were acked by DynamoDB and persist in the table. There is
 * no rollback: callers that need an all-or-nothing write must use
 * `TransactWriteItems` (capped at 100 items per request) instead of this
 * helper.
 *
 * @param client - DynamoDB Document client
 * @param tableName - Target DynamoDB table name
 * @param requestItems - Array of write requests (PutRequest or DeleteRequest objects)
 * @param options.signal - Optional AbortSignal cancelling in-flight retries
 * @throws {BatchWriteIncompleteError} if retries are exhausted with items still unprocessed
 */
export async function batchWriteWithRetry(
  client: DynamoDBDocument,
  tableName: string,
  requestItems: WriteRequest[],
  options: BatchWriteOptions = {},
): Promise<void> {
  if (requestItems.length === 0) return;

  // Loop over UnprocessedItems OUTSIDE the transient-error retry wrapper.
  // This way a ThrottlingException during an UnprocessedItems follow-up call
  // doesn't cause the outer loop to re-submit items that already succeeded —
  // which would be an idempotency problem for DeleteRequests against items
  // that have since been recreated.
  const initialCount = requestItems.length;
  let pending: WriteRequest[] = requestItems;
  let retryDelay = INITIAL_BACKOFF_DELAY_MS;
  let retryCount = 0;

  while (pending.length > 0) {
    const result = await withDynamoDBRetry(
      async () => {
        return await client.batchWrite({
          RequestItems: { [tableName]: pending },
        });
      },
      { signal: options.signal },
    );

    const unprocessed = (result.UnprocessedItems?.[tableName] as WriteRequest[] | undefined) ?? [];
    if (unprocessed.length === 0) return;

    retryCount++;
    if (retryCount > MAX_UNPROCESSED_RETRIES) {
      throw new BatchWriteIncompleteError(
        initialCount - unprocessed.length,
        unprocessed,
        MAX_UNPROCESSED_RETRIES,
      );
    }
    // Full jitter so concurrent batch writers don't re-pressure the partition together.
    await sleep(fullJitter(retryDelay), options.signal);
    retryDelay = nextBackoffDelay(retryDelay);
    pending = unprocessed;
  }
}

/**
 * Execute batch writes for an arbitrary number of items, chunking into batches of 25.
 *
 * @remarks
 * Each batch is retried independently. On failure of one batch, any preceding
 * batches in the same call have already been acked by DynamoDB. This helper
 * does not span a transaction across batches — see
 * {@link batchWriteWithRetry} for the partial-success contract.
 *
 * @param client - DynamoDB Document client
 * @param tableName - Target DynamoDB table name
 * @param requestItems - Array of write requests (can exceed 25)
 * @param options.signal - Optional AbortSignal cancelling in-flight retries
 * @throws {BatchWriteIncompleteError} if any batch fails after exhausting retries
 */
export async function batchWriteAllWithRetry(
  client: DynamoDBDocument,
  tableName: string,
  requestItems: WriteRequest[],
  options: BatchWriteOptions = {},
): Promise<void> {
  if (requestItems.length === 0) return;

  for (let i = 0; i < requestItems.length; i += BATCH_WRITE_MAX) {
    const batch = requestItems.slice(i, i + BATCH_WRITE_MAX);
    await batchWriteWithRetry(client, tableName, batch, options);
  }
}
