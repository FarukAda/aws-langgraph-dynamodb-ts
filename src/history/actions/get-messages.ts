/**
 * Get all messages for a session
 * Queries individual message items and deserializes to BaseMessage instances
 */

import { BaseMessage, mapStoredMessagesToChatMessages } from '@langchain/core/messages';

import { MAX_LOOP_ITERATIONS, MAX_TOTAL_ITEMS_IN_MEMORY } from '../../shared';
import type { GetMessagesActionParams, DynamoDBMessageItem } from '../types';
import { validateUserId, validateSessionId, withDynamoDBRetry } from '../utils';

/**
 * Get all messages for a session from DynamoDB
 * Queries message items by SK prefix and deserializes to proper BaseMessage instances
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

  // Query all message items for the session using SK prefix
  const messagePrefix = `${sessionId}#msg#`;
  const messages: DynamoDBMessageItem[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;
  let iterationCount = 0;

  do {
    // Prevent infinite loops
    iterationCount++;
    if (iterationCount > MAX_LOOP_ITERATIONS) {
      throw new Error('getMessages operation exceeded maximum iteration limit');
    }

    const result = await withDynamoDBRetry(async () => {
      return await client.query({
        TableName: tableName,
        KeyConditionExpression: 'userId = :userId AND begins_with(sessionId, :prefix)',
        ExpressionAttributeValues: {
          ':userId': userId,
          ':prefix': messagePrefix,
        },
        ExclusiveStartKey: lastEvaluatedKey,
      });
    });

    if (result.Items && result.Items.length > 0) {
      // Prevent memory exhaustion
      if (messages.length + result.Items.length > MAX_TOTAL_ITEMS_IN_MEMORY) {
        throw new Error('getMessages operation exceeded maximum items in memory limit');
      }
      messages.push(...(result.Items as DynamoDBMessageItem[]));
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  // Return empty array if no messages found
  if (messages.length === 0) {
    return [];
  }

  // Sort by messageIndex to ensure chronological order
  messages.sort((a, b) => a.messageIndex - b.messageIndex);

  // Deserialize StoredMessage objects to proper BaseMessage instances
  const storedMessages = messages.map((item) => item.message);
  return mapStoredMessagesToChatMessages(storedMessages);
};
