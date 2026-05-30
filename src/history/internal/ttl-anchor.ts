import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { SESSION_SORT_KEY, sessionPartition } from './keys';
import type { HistoryContext } from './setup';

/**
 * Resolve the session's creation-anchored TTL: the value already stored on the
 * SESSION item if one exists, otherwise the supplied `candidate`. This is a
 * strongly-consistent read, never a write, so it cannot leave a metadata-only
 * orphan row when the following append transaction fails. The append transaction
 * itself sets the anchor via `if_not_exists`, so concurrent first appends still
 * converge on a single shared expiry, and every later append reuses it — giving
 * all message items in a session one uniform expiry.
 */
export async function resolveTtlAnchor(
  context: HistoryContext,
  sessionId: string,
  candidate: number,
): Promise<number> {
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
  return typeof ttl === 'number' ? ttl : candidate;
}
