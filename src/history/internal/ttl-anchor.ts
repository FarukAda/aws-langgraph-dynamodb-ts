import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { SESSION_SORT_KEY, sessionPartition } from './keys';
import type { HistoryContext } from './setup';

/**
 * Read the session's creation-anchored TTL from its metadata item, if present.
 * Returns `undefined` for a new session (no metadata yet) so the caller can
 * establish the anchor from `now + ttl` on the first append.
 */
export async function readSessionTtlAnchor(
  context: HistoryContext,
  sessionId: string,
): Promise<number | undefined> {
  const result = await withDynamoDBRetry(() =>
    context.client.get({
      TableName: context.tableName,
      Key: { PK: sessionPartition(sessionId), SK: SESSION_SORT_KEY },
      ConsistentRead: true,
      ProjectionExpression: '#ttl',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
    }),
  );
  const ttl = (result.Item as { ttl?: number } | undefined)?.ttl;
  return typeof ttl === 'number' ? ttl : undefined;
}
