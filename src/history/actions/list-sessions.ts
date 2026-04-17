/**
 * List all sessions for a user
 */

import { MAX_TOTAL_ITEMS_IN_MEMORY, getLogger } from '../../shared';
import type { ListSessionsActionParams, SessionMetadata } from '../types';
import { validateUserId, validateLimit, withDynamoDBRetry } from '../utils';

/**
 * List all sessions for a user, sorted by most recent
 * Uses projection expression to exclude messages for performance
 *
 * @remarks
 * **Performance note:** This action loads all metadata items for a user into memory
 * and sorts client-side by `updatedAt`. DynamoDB sorts by SK (sessionId), so server-side
 * sorted pagination is not possible with the current schema.
 *
 * For users with thousands of sessions, consider adding a GSI on `userId + updatedAt`
 * to enable server-side sorting with DynamoDB `Limit` and `ScanIndexForward`.
 *
 * A safety limit of {@link MAX_TOTAL_ITEMS_IN_MEMORY} is applied to prevent
 * unbounded memory growth.
 *
 * @param params - Parameters for the list sessions operation
 * @returns Array of session metadata, sorted by most recent first
 * @throws Error if the operation fails or validation fails
 */
export const listSessionsAction = async (
  params: ListSessionsActionParams,
): Promise<SessionMetadata[]> => {
  const { client, tableName, userId, limit, signal } = params;

  // Validate inputs
  validateUserId(userId);
  validateLimit(limit);

  const sessions: SessionMetadata[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;

  // Paginate through all results - must fetch ALL sessions before sorting
  // DynamoDB sorts by SK (sessionId), not updatedAt, so we cannot rely on
  // DynamoDB's Limit to return the most recent sessions
  do {
    const result = await withDynamoDBRetry(
      async () => {
        return await client.query({
          TableName: tableName,
          KeyConditionExpression: 'userId = :userId',
          FilterExpression: 'itemType = :metadata',
          ExpressionAttributeValues: {
            ':userId': userId,
            ':metadata': 'metadata',
          },
          ProjectionExpression: 'sessionId, title, createdAt, updatedAt, messageCount',
          ExclusiveStartKey: lastEvaluatedKey,
        });
      },
      { signal },
    );

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

    // Safety limit: prevent unbounded memory growth. Users near this bound should
    // add a (userId, updatedAt) GSI — see method JSDoc.
    if (sessions.length >= MAX_TOTAL_ITEMS_IN_MEMORY) {
      getLogger().warn(
        `listSessions truncated at ${MAX_TOTAL_ITEMS_IN_MEMORY} items for userId="${userId}"; ` +
          `older sessions are not returned. Add a GSI on (userId, updatedAt) for full coverage.`,
      );
      break;
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  // Sort by most recent first (updatedAt DESC)
  sessions.sort((a, b) => b.updatedAt - a.updatedAt);

  // Enforce limit on final result
  return limit ? sessions.slice(0, limit) : sessions;
};
