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

  const now = Date.now();

  // Generate a title if this is the first message and no title provided
  let sessionTitle = title;
  if (!sessionTitle) {
    sessionTitle = generateTitle(message);
  }

  // Build update expression
  const updateExpressionParts: string[] = ['updatedAt = :updatedAt'];
  const expressionAttributeValues: Record<string, any> = {
    ':updatedAt': now,
    ':createdAt': now,
    ':emptyList': [],
    ':one': 1,
    ':message': [message],
  };

  if (sessionTitle) {
    updateExpressionParts.push('title = if_not_exists(title, :title)');
    expressionAttributeValues[':title'] = sessionTitle;
  }

  updateExpressionParts.push(
    'messages = list_append(if_not_exists(messages, :emptyList), :message)',
  );
  updateExpressionParts.push('messageCount = if_not_exists(messageCount, :zero) + :one');
  expressionAttributeValues[':zero'] = 0;

  // Add TTL if configured
  if (ttlDays !== undefined) {
    updateExpressionParts.push('ttl = :ttl');
    expressionAttributeValues[':ttl'] = Math.floor(Date.now() / 1000) + ttlDays * 24 * 60 * 60;
  }

  // Execute with retry logic
  await withDynamoDBRetry(async () => {
    await client.update({
      TableName: tableName,
      Key: {
        userId,
        sessionId,
      },
      UpdateExpression: `SET ${updateExpressionParts.join(', ')}, createdAt = if_not_exists(createdAt, :createdAt)`,
      ExpressionAttributeValues: expressionAttributeValues,
    });
  });
};
