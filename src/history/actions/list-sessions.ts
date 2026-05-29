import { paginateScan } from '../../shared/dynamodb/scan';
import type { HistoryContext } from '../internal/setup';
import type { ChatSessionItem, SessionMetadata } from '../types';

/** List all sessions as metadata summaries, newest-updated first. */
export async function listSessions(context: HistoryContext): Promise<SessionMetadata[]> {
  const sessions: SessionMetadata[] = [];
  for await (const raw of paginateScan({
    client: context.client,
    params: { TableName: context.tableName },
  })) {
    const item = raw as ChatSessionItem;
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
