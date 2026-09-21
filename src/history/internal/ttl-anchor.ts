import { nowSeconds } from '../../shared/clock';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { retryFor } from '../../shared/dynamodb/retry-policy';
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
 *
 * When a stale anchor is healed, only the persisted SESSION row's `ttl` is
 * force-refreshed — the message rows already written under the expired
 * anchor keep their own (already-expired) `ttl` and get swept independently
 * by DynamoDB's TTL sweep. Until that sweep runs (and until
 * `reconcileMessageCount` repairs the count), `messageCount` can therefore be
 * temporarily overstated relative to what `getMessages` actually returns.
 * This is expected, not a bug.
 *
 * Accepts: `candidate` — the anchor this append would use if the session has
 * none, already computed from the configured ttl.
 *
 * Returns: the anchor to stamp on this append's messages, and whether the
 * SESSION row's own `ttl` must be force-overwritten rather than left to
 * `if_not_exists`.
 *
 * Throws: whatever the read throws after retries.
 *
 * Guarantees: a read, never a write — so a failure of the append that follows
 * cannot leave a metadata-only orphan row behind. Strongly consistent, so an
 * anchor an earlier append committed is always seen. Two appends that start
 * together on a session that has none each propose their own candidate; the
 * append transaction's own condition is what settles which persists, so this
 * read never has to be the arbiter (see {@link buildSessionUpdateItem}).
 */
export async function resolveTtlAnchor(
  context: HistoryContext,
  sessionId: string,
  candidate: number,
  signal?: AbortSignal,
): Promise<TtlAnchorResult> {
  const result = await withDynamoDBRetry(
    (request) =>
      context.client.get(
        {
          TableName: context.tableName,
          Key: { PK: sessionPartition(sessionId), SK: SESSION_SORT_KEY },
          ConsistentRead: true,
          ProjectionExpression: '#ttl',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
        },
        request,
      ),
    retryFor(context, signal),
  );
  const ttl = (result.Item as { ttl?: number } | undefined)?.ttl;
  if (typeof ttl === 'number' && ttl > nowSeconds()) {
    return { ttlTimestamp: ttl, refresh: false };
  }
  return { ttlTimestamp: candidate, refresh: true };
}
