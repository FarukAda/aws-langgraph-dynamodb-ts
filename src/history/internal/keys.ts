/** Fixed sort key for the per-session metadata item. */
export const SESSION_SORT_KEY = 'SESSION';

const MESSAGE_PREFIX = 'MSG#';

/** Partition key for a chat session: the session id itself. */
export function sessionPartition(sessionId: string): string {
  return sessionId;
}

/** Sort key for a single message item, ordered by its monotonic ULID. */
export function messageSortKey(ulid: string): string {
  return `${MESSAGE_PREFIX}${ulid}`;
}

/** `begins_with` prefix selecting every message item in a session. */
export function messageSortKeyPrefix(): string {
  return MESSAGE_PREFIX;
}
