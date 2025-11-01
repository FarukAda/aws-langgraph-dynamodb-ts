/**
 * List all sessions for a user
 */

import type { ListSessionsActionParams, SessionMetadata } from '../types';
import { validateUserId, validateLimit, withDynamoDBRetry } from '../utils';

/**
 * List all sessions for a user, sorted by most recent
 * Uses projection expression to exclude messages for performance
 *
 * @param params - Parameters for the list sessions operation
 * @returns Array of session metadata, sorted by most recent first
 * @throws Error if the operation fails or validation fails
 */
export const listSessionsAction = async (
  params: ListSessionsActionParams,
): Promise<SessionMetadata[]> => {
  const { client, tableName, userId, limit } = params;

  // Validate inputs
  validateUserId(userId);
  validateLimit(limit);

  const sessions: SessionMetadata[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;

  // Paginate through all results
  do {
    const result = await withDynamoDBRetry(async () => {
      return await client.query({
        TableName: tableName,
        KeyConditionExpression: 'userId = :userId',
        ExpressionAttributeValues: {
          ':userId': userId,
        },
        ProjectionExpression: 'sessionId, title, createdAt, updatedAt, messageCount',
        Limit: limit,
        ExclusiveStartKey: lastEvaluatedKey,
      });
    });

    if (!result.Items || result.Items.length === 0) {
      break;
    }

    // Map items to SessionMetadata
    const mappedSessions: SessionMetadata[] = result.Items.map((item) => ({
      sessionId: item.sessionId as string,
      title: item.title as string,
      createdAt: item.createdAt as number,
      updatedAt: item.updatedAt as number,
      messageCount: item.messageCount as number,
    }));

    sessions.push(...mappedSessions);
    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  // Sort by most recent first (updatedAt DESC)
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);

  return sessions;
};
