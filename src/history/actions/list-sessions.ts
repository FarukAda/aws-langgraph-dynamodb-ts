import { nowSeconds as currentSeconds } from '../../shared/clock';
import { isExpiredRow } from '../../shared/dynamodb/expiry';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { paginateScan } from '../../shared/dynamodb/scan';
import { SESSION_SORT_KEY } from '../internal/keys';
import type { HistoryContext } from '../internal/setup';
import type { ChatSessionItem, SessionMetadata } from '../types';

/**
 * List all sessions as metadata summaries, newest-updated first. The scan is
 * filtered to session items so the adapter works on a table shared with the
 * checkpointer/store; foreign rows are also skipped defensively, and rows past
 * their TTL are filtered out exactly as `getMessages` filters expired messages.
 */
export async function listSessions(
  context: HistoryContext,
  options?: { maxIterations?: number; maxItems?: number; signal?: AbortSignal },
): Promise<SessionMetadata[]> {
  const sessions: SessionMetadata[] = [];
  const nowSeconds = currentSeconds();
  for await (const raw of paginateScan({
    retry: retryFor(context, options?.signal),
    signal: options?.signal,
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
    if (isExpiredRow(item, nowSeconds)) continue;
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
