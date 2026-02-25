/**
 * Add multiple messages to a session
 * Uses an atomic counter to claim a unique message index range, preventing race conditions
 * Uses transactWrite for message items (≤100, enforced by validation)
 */

import type { AddMessagesActionParams } from '../types';
import {
  validateUserId,
  validateSessionId,
  validateMessages,
  validateMessagesSize,
  validateTitle,
  validateTTLDays,
  withDynamoDBRetry,
  generateTitle,
  buildMessageItems,
  buildAtomicMetadataUpdate,
} from '../utils';

/**
 * Add multiple messages to a session
 * Atomically claims message indices via DynamoDB's ADD operation, then writes message items
 *
 * @param params - Parameters for the add messages operation
 * @throws Error if the operation fails or validation fails
 */
export const addMessagesAction = async (params: AddMessagesActionParams): Promise<void> => {
  const { client, tableName, userId, sessionId, messages, title, ttlDays } = params;

  // Validate inputs (enforces max 100 messages per batch)
  validateUserId(userId);
  validateSessionId(sessionId);
  validateMessages(messages);
  validateMessagesSize(messages);
  validateTitle(title);
  validateTTLDays(ttlDays);

  // Generate a title if this is the first message batch and no title provided
  const sessionTitle = title ?? generateTitle(messages[0]);

  // Atomically claim a range of message indices via ADD messageCount
  const { updateExpression, expressionAttributeValues } = buildAtomicMetadataUpdate(
    sessionTitle,
    messages.length, // Claiming N indices
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

  // The new messageCount is the count AFTER incrementing by messages.length
  // So our claimed starting index is newCount - messages.length
  const newCount = (updateResult.Attributes?.messageCount as number) ?? messages.length;
  const startIndex = newCount - messages.length;

  // Build all message items
  const messageItems = buildMessageItems(userId, sessionId, messages, startIndex, ttlDays);

  // Write all message items in a single transaction (max 100 items, enforced by validation)
  await withDynamoDBRetry(async () => {
    await client.transactWrite({
      TransactItems: messageItems.map((item) => ({
        Put: {
          TableName: tableName,
          Item: item,
        },
      })),
    });
  });
};
