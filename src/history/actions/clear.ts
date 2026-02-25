/**
 * Clear all messages and metadata for a session
 * Deletes both the metadata item and all individual message items
 */

import {
  batchWriteAllWithRetry,
  MAX_LOOP_ITERATIONS,
  MAX_TOTAL_ITEMS_IN_MEMORY,
} from '../../shared';
import type { ClearActionParams } from '../types';
import { validateUserId, validateSessionId, withDynamoDBRetry } from '../utils';

/**
 * Clear all messages in a session by deleting all items (metadata + messages)
 * Queries all items with the session prefix, then batch-deletes them
 *
 * @param params - Parameters for the clear operation
 * @throws Error if the operation fails or validation fails
 */
export const clearAction = async (params: ClearActionParams): Promise<void> => {
  const { client, tableName, userId, sessionId } = params;

  // Validate inputs
  validateUserId(userId);
  validateSessionId(sessionId);

  // Collect all item keys to delete: metadata item + all message items
  const keysToDelete: Array<{ userId: string; sessionId: string }> = [];

  // Add the metadata item key
  keysToDelete.push({ userId, sessionId });

  // Query all message items by SK prefix
  const messagePrefix = `${sessionId}#msg#`;
  let lastEvaluatedKey: Record<string, any> | undefined;
  let iterationCount = 0;

  do {
    // Prevent infinite loops
    iterationCount++;
    if (iterationCount > MAX_LOOP_ITERATIONS) {
      throw new Error('Clear operation exceeded maximum iteration limit');
    }

    const result = await withDynamoDBRetry(async () => {
      return await client.query({
        TableName: tableName,
        KeyConditionExpression: 'userId = :userId AND begins_with(sessionId, :prefix)',
        ExpressionAttributeValues: {
          ':userId': userId,
          ':prefix': messagePrefix,
        },
        ProjectionExpression: 'userId, sessionId',
        ExclusiveStartKey: lastEvaluatedKey,
      });
    });

    if (result.Items && result.Items.length > 0) {
      // Prevent memory exhaustion
      if (keysToDelete.length + result.Items.length > MAX_TOTAL_ITEMS_IN_MEMORY) {
        throw new Error('Clear operation exceeded maximum items in memory limit');
      }
      keysToDelete.push(
        ...result.Items.map((item) => ({
          userId: item.userId as string,
          sessionId: item.sessionId as string,
        })),
      );
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  // Batch delete all items (metadata + messages) using shared utility
  const deleteRequests = keysToDelete.map((key) => ({
    DeleteRequest: { Key: key },
  }));

  await batchWriteAllWithRetry(client, tableName, deleteRequests);
};
