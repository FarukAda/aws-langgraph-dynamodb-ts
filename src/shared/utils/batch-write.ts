/**
 * Shared batch write utilities with UnprocessedItems retry logic
 * Eliminates duplication of the retry pattern across checkpointer, store, and history modules
 */

import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { MAX_UNPROCESSED_RETRIES, BATCH_WRITE_MAX } from './constants';
import { withDynamoDBRetry } from './retry';

interface PutWriteRequest {
  PutRequest: { Item: object };
}

interface DeleteWriteRequest {
  DeleteRequest: { Key: object };
}

type WriteRequest = PutWriteRequest | DeleteWriteRequest;

/**
 * Execute a single batchWrite call with exponential backoff retry for UnprocessedItems
 *
 * @param client - DynamoDB Document client
 * @param tableName - Target DynamoDB table name
 * @param requestItems - Array of write requests (PutRequest or DeleteRequest objects)
 * @throws Error if retries are exhausted with remaining unprocessed items
 */
export async function batchWriteWithRetry(
  client: DynamoDBDocument,
  tableName: string,
  requestItems: WriteRequest[],
): Promise<void> {
  if (requestItems.length === 0) return;

  await withDynamoDBRetry(async () => {
    const result = await client.batchWrite({
      RequestItems: {
        [tableName]: requestItems,
      },
    });

    let unprocessed = result.UnprocessedItems?.[tableName];
    let retryDelay = 100;
    let retryCount = 0;
    while (unprocessed && unprocessed.length > 0) {
      retryCount++;
      if (retryCount > MAX_UNPROCESSED_RETRIES) {
        throw new Error(
          `Failed to process all items after ${MAX_UNPROCESSED_RETRIES} retries. ` +
            `${unprocessed.length} items remain unprocessed.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      retryDelay = Math.min(retryDelay * 2, 5000);
      const retryResult = await client.batchWrite({
        RequestItems: { [tableName]: unprocessed },
      });
      unprocessed = retryResult.UnprocessedItems?.[tableName];
    }
  });
}

/**
 * Execute batch writes for an arbitrary number of items, chunking into batches of 25
 *
 * @param client - DynamoDB Document client
 * @param tableName - Target DynamoDB table name
 * @param requestItems - Array of write requests (can exceed 25)
 * @throws Error if any batch fails after exhausting retries
 */
export async function batchWriteAllWithRetry(
  client: DynamoDBDocument,
  tableName: string,
  requestItems: WriteRequest[],
): Promise<void> {
  if (requestItems.length === 0) return;

  for (let i = 0; i < requestItems.length; i += BATCH_WRITE_MAX) {
    const batch = requestItems.slice(i, i + BATCH_WRITE_MAX);
    await batchWriteWithRetry(client, tableName, batch);
  }
}
