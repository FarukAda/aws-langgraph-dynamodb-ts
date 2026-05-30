import { paginateScan } from '../../shared/dynamodb/scan';
import { SESSION_SORT_KEY } from '../internal/keys';
import type { HistoryContext } from '../internal/setup';
import type { ChatSessionItem, SessionMetadata } from '../types';

/**
 * List all sessions as metadata summaries, newest-updated first. The scan is
 * filtered to session items so the adapter works on a table shared with the
 * checkpointer/store; foreign rows are also skipped defensively.
 */
export async function listSessions(context: HistoryContext): Promise<SessionMetadata[]> {
  const sessions: SessionMetadata[] = [];
  for await (const raw of paginateScan({
    client: context.client,
    params: {
      TableName: context.tableName,
      FilterExpression: '#sk = :session',
      ExpressionAttributeNames: { '#sk': 'SK' },
      ExpressionAttributeValues: { ':session': SESSION_SORT_KEY },
    },
  })) {
    const item = raw as ChatSessionItem;
    if (item.SK !== SESSION_SORT_KEY || typeof item.sessionId !== 'string') continue;
    sessions.push({
      sessionId: item.sessionId,
      title: item.title,
      messageCount: item.messageCount,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  }
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return sessions;
}
