/**
 * Add multiple messages to a session using optimistic concurrency control.
 *
 * Reads the current messageCount, writes N message items and the updated counter
 * in a single TransactWrite (N ≤ 99, leaving room for the metadata item in the
 * 100-item transaction limit). The metadata update has a conditional check on the
 * observed count; on concurrent modification we re-read and retry.
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
  withOptimisticRetry,
  generateTitle,
  buildMessageItems,
  buildOptimisticMetadataUpdate,
} from '../utils';

export const addMessagesAction = async (params: AddMessagesActionParams): Promise<void> => {
  const { client, tableName, userId, sessionId, messages, title, ttlDays, signal } = params;

  validateUserId(userId);
  validateSessionId(sessionId);
  validateMessages(messages);
  validateMessagesSize(messages);
  validateTitle(title);
  validateTTLDays(ttlDays);

  const sessionTitle = title ?? generateTitle(messages[0]);

  await withOptimisticRetry(`addMessages:${sessionId}`, async () => {
    signal?.throwIfAborted();
    const existing = await withDynamoDBRetry(
      async () => {
        return await client.get({
          TableName: tableName,
          Key: { userId, sessionId },
          ConsistentRead: true,
          ProjectionExpression: 'messageCount',
        });
      },
      { signal },
    );

    const expectedCount = existing.Item?.messageCount as number | undefined;
    const currentCount = expectedCount ?? 0;
    const newCount = currentCount + messages.length;

    const messageItems = buildMessageItems(userId, sessionId, messages, currentCount, ttlDays);
    const {
      updateExpression,
      conditionExpression,
      expressionAttributeValues,
      expressionAttributeNames,
    } = buildOptimisticMetadataUpdate(sessionTitle, newCount, expectedCount, ttlDays);

    await client.transactWrite({
      TransactItems: [
        ...messageItems.map((item) => ({ Put: { TableName: tableName, Item: item } })),
        {
          Update: {
            TableName: tableName,
            Key: { userId, sessionId },
            UpdateExpression: updateExpression,
            ConditionExpression: conditionExpression,
            ExpressionAttributeValues: expressionAttributeValues,
            ...(expressionAttributeNames
              ? { ExpressionAttributeNames: expressionAttributeNames }
              : {}),
          },
        },
      ],
    });
  });
};
