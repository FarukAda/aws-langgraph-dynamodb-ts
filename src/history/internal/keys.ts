/** Fixed sort key for the single per-session item. */
export const SESSION_SORT_KEY = 'SESSION';

/** Partition key for a chat session: the session id itself. */
export function sessionPartition(sessionId: string): string {
  return sessionId;
}
