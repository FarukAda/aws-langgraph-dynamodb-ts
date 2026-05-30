import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { SESSION_SORT_KEY, sessionPartition } from './keys';
import type { HistoryContext } from './setup';

/**
 * Atomically establish and read back the session's creation-anchored TTL. The
 * conditional `if_not_exists` write means the first append fixes the anchor and
 * every later or simultaneous append observes that same value via `ALL_NEW`, so
 * all message items in the session share one expiry with no race.
 */
export async function establishTtlAnchor(
  context: HistoryContext,
  sessionId: string,
  candidate: number,
): Promise<number> {
  const result = await withDynamoDBRetry(() =>
    context.client.update({
      TableName: context.tableName,
      Key: { PK: sessionPartition(sessionId), SK: SESSION_SORT_KEY },
      UpdateExpression: 'SET #ttl = if_not_exists(#ttl, :cand)',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':cand': candidate },
      ReturnValues: 'ALL_NEW',
    }),
  );
  const ttl = (result.Attributes as { ttl?: number } | undefined)?.ttl;
  return typeof ttl === 'number' ? ttl : candidate;
}
