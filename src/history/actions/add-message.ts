/**
 * Add a single message to a session
 * Uses an atomic counter to claim a unique message index, preventing race conditions
 */

import type { AddMessageActionParams } from '../types';
import {
  validateUserId,
  validateSessionId,
  validateMessage,
  validateTitle,
  validateTTLDays,
  withDynamoDBRetry,
  generateTitle,
  buildMessageItems,
  buildAtomicMetadataUpdate,
} from '../utils';

/**
 * Add a single message to a session
 * Atomically claims a message index via DynamoDB's ADD operation, then writes the message item
 *
 * @param params - Parameters for the add message operation
 * @throws Error if the operation fails or validation fails
 */
export const addMessageAction = async (params: AddMessageActionParams): Promise<void> => {
  const { client, tableName, userId, sessionId, message, title, ttlDays } = params;

  // Validate inputs
  validateUserId(userId);
  validateSessionId(sessionId);
  validateMessage(message);
  validateTitle(title);
  validateTTLDays(ttlDays);

  // Generate a title if this is the first message and no title provided
  const sessionTitle = title ?? generateTitle(message);

  // Atomically claim a message index via ADD messageCount
  const { updateExpression, expressionAttributeValues } = buildAtomicMetadataUpdate(
    sessionTitle,
    1, // Claiming 1 index
    ttlDays,
  );

  const updateResult = await withDynamoDBRetry(async () => {
    return await client.update({
      TableName: tableName,
      Key: { userId, sessionId },
      UpdateExpression: updateExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: 'ALL_NEW',
    });
  });

  // The new messageCount is the count AFTER incrementing by 1
  // So our claimed index is newCount - 1
  const newCount = (updateResult.Attributes?.messageCount as number) ?? 1;
  const startIndex = newCount - 1;

  // Build and write the message item
  const [messageItem] = buildMessageItems(userId, sessionId, [message], startIndex, ttlDays);

  await withDynamoDBRetry(async () => {
    await client.put({
      TableName: tableName,
      Item: messageItem,
    });
  });
};
