import { nowSeconds as currentSeconds } from '../../shared/clock';
import { paginateScan } from '../../shared/dynamodb/scan';
import { SESSION_SORT_KEY } from '../internal/keys';
import type { HistoryContext } from '../internal/setup';
import type { ChatSessionItem, SessionMetadata } from '../types';

/**
 * True when a session row is past its TTL. DynamoDB's background sweep can lag
 * up to 48h, so an expired session would otherwise keep appearing in listings
 * after `getMessages` had already stopped returning its messages — the same
 * filter that read path applies.
 */
function isExpired(item: ChatSessionItem, nowSeconds: number): boolean {
  return item.ttl !== undefined && item.ttl <= nowSeconds;
}

/**
 * List all sessions as metadata summaries, newest-updated first. The scan is
 * filtered to session items so the adapter works on a table shared with the
 * checkpointer/store; foreign rows are also skipped defensively, and rows past
 * their TTL are filtered out exactly as `getMessages` filters expired messages.
 */
export async function listSessions(
  context: HistoryContext,
  options?: { maxIterations?: number; maxItems?: number },
): Promise<SessionMetadata[]> {
  const sessions: SessionMetadata[] = [];
  const nowSeconds = currentSeconds();
  for await (const raw of paginateScan({
    retry: context.retry,
    client: context.client,
    params: {
      TableName: context.tableName,
      FilterExpression: '#sk = :session',
      ExpressionAttributeNames: { '#sk': 'SK' },
      ExpressionAttributeValues: { ':session': SESSION_SORT_KEY },
    },
    maxIterations: options?.maxIterations,
    maxItems: options?.maxItems,
  })) {
    const item = raw as ChatSessionItem;
    if (item.SK !== SESSION_SORT_KEY || typeof item.sessionId !== 'string') continue;
    if (isExpired(item, nowSeconds)) continue;
    sessions.push({
      sessionId: item.sessionId,
      title: item.title,
      messageCount: item.messageCount,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  }
  /**
   * Ordinal, not `localeCompare`: these are ISO-8601 timestamps, whose
   * byte order already is their chronological order. Locale-aware collation
   * applies rules (case folding, punctuation weighting) that have no meaning
   * here and are not guaranteed to agree with it in every locale.
   */
  sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return sessions;
}
