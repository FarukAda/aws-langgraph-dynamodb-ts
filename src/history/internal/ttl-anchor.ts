import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { SESSION_SORT_KEY, sessionPartition } from './keys';
import type { HistoryContext } from './setup';

/** The resolved ttl anchor plus whether the persisted SESSION-row value must be force-refreshed. */
export interface TtlAnchorResult {
  ttlTimestamp: number;
  refresh: boolean;
}

/**
 * Resolve the session's creation-anchored TTL: the value already stored on the
 * SESSION item, if one exists AND is still in the future; otherwise the
 * supplied `candidate`, with `refresh: true` so the caller force-overwrites
 * the stale/missing persisted anchor instead of leaving it stuck (DynamoDB's
 * `if_not_exists` would otherwise never correct an already-expired anchor).
 * This is a strongly-consistent read, never a write, so it cannot leave a
 * metadata-only orphan row when the following append transaction fails.
 */
export async function resolveTtlAnchor(
  context: HistoryContext,
  sessionId: string,
  candidate: number,
): Promise<TtlAnchorResult> {
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
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (typeof ttl === 'number' && ttl > nowSeconds) {
    return { ttlTimestamp: ttl, refresh: false };
  }
  return { ttlTimestamp: candidate, refresh: true };
}
