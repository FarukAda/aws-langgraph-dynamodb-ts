/**
 * Get all messages for a session
 */

import { BaseMessage } from '@langchain/core/messages';

import type { GetMessagesActionParams, DynamoDBSessionItem } from '../types';
import { validateUserId, validateSessionId, withDynamoDBRetry } from '../utils';

/**
 * Get all messages for a session from DynamoDB
 * Messages are returned in chronological order
 *
 * @param params - Parameters for the get messages operation
 * @returns Array of BaseMessage objects in chronological order
 * @throws Error if the operation fails or validation fails
 */
export const getMessagesAction = async (
  params: GetMessagesActionParams,
): Promise<BaseMessage[]> => {
  const { client, tableName, userId, sessionId } = params;

  // Validate inputs
  validateUserId(userId);
  validateSessionId(sessionId);

  // Execute with retry logic
  const result = await withDynamoDBRetry(async () => {
    return await client.get({
      TableName: tableName,
      Key: {
        userId,
        sessionId,
      },
    });
  });

  // Return empty array if session doesn't exist
  if (!result.Item) {
    return [];
  }

  const item = result.Item as DynamoDBSessionItem;

  // Return messages array (already in chronological order)
  return item.messages || [];
};
