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

  const now = Date.now();

  // Generate a title if this is the first message batch and no title provided
  let sessionTitle = title;
  if (!sessionTitle) {
    sessionTitle = generateTitle(messages[0]);
  }

  // Build update expression
  const updateExpressionParts: string[] = ['updatedAt = :updatedAt'];
  const expressionAttributeValues: Record<string, any> = {
    ':updatedAt': now,
    ':createdAt': now,
    ':emptyList': [],
    ':messageCount': messages.length,
    ':messages': messages,
  };

  if (sessionTitle) {
    updateExpressionParts.push('title = if_not_exists(title, :title)');
    expressionAttributeValues[':title'] = sessionTitle;
  }

  updateExpressionParts.push(
    'messages = list_append(if_not_exists(messages, :emptyList), :messages)',
  );
  updateExpressionParts.push('messageCount = if_not_exists(messageCount, :zero) + :messageCount');
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
