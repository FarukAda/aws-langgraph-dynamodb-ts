/**
 * Add a single message to a session
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
  buildMessageUpdateExpression,
} from '../utils';

/**
 * Add a single message to a session
 * Automatically handles creating a new session with a title
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
  let sessionTitle = title;
  if (!sessionTitle) {
    sessionTitle = generateTitle(message);
  }
  // Build update expression using utility
  const { updateExpression, expressionAttributeValues } = buildMessageUpdateExpression({
    messages: message,
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
