/**
 * Add multiple messages to a session
 */

import type { AddMessagesActionParams } from '../types';
import {
  validateUserId,
  validateSessionId,
  validateMessages,
  validateTitle,
  validateTTLDays,
  withDynamoDBRetry,
  generateTitle,
  buildMessageUpdateExpression,
} from '../utils';

/**
 * Add multiple messages to a session
 * Automatically handles creating a new session with title
 * Preferred over calling addMessage multiple times
 *
 * @param params - Parameters for the add messages operation
 * @throws Error if the operation fails or validation fails
 */
export const addMessagesAction = async (params: AddMessagesActionParams): Promise<void> => {
  const { client, tableName, userId, sessionId, messages, title, ttlDays } = params;

  // Validate inputs
  validateUserId(userId);
  validateSessionId(sessionId);
  validateMessages(messages);
  validateTitle(title);
  validateTTLDays(ttlDays);

  // Generate a title if this is the first message batch and no title provided
  let sessionTitle = title;
  if (!sessionTitle) {
    sessionTitle = generateTitle(messages[0]);
  }
  // Build update expression using utility
  const { updateExpression, expressionAttributeValues } = buildMessageUpdateExpression({
    messages,
    title: sessionTitle,
    ttlDays,
  });

  // Execute with retry logic
  await withDynamoDBRetry(async () => {
    await client.update({
      TableName: tableName,
      Key: {
        userId,
        sessionId,
      },
      UpdateExpression: updateExpression,
      ExpressionAttributeValues: expressionAttributeValues,
    });
  });
};
