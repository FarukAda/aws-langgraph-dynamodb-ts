/** Reserved separator joining sort-key segments; forbidden inside a session id. */
export const SORT_KEY_SEPARATOR = '#';

/**
 * Item-kind tag distinguishing this adapter's sort keys from another
 * adapter's on a table shared via `DynamoDBFactory.createAll()` — matches the
 * pattern the checkpointer module already uses for its own META#/PAYLOAD#/
 * WRITE# keys. Without it, `SESSION_SORT_KEY` alone was a bare, common-word
 * literal a store caller could produce by accident (e.g.
 * `store.put([sessionId], 'SESSION', ...)`, since `sortKey` collapses a
 * single-element namespace down to just the key).
 */
const ADAPTER_PREFIX = `HISTORY${SORT_KEY_SEPARATOR}`;

/** Fixed sort key for the per-session metadata item. */
export const SESSION_SORT_KEY = `${ADAPTER_PREFIX}SESSION`;

const MESSAGE_PREFIX = `${ADAPTER_PREFIX}MSG#`;

/**
 * Adapter tag prefixed to every chat-history partition key — see the
 * equivalent in checkpointer/internal/keys.ts for why the three adapters'
 * partitions must not overlap on a shared table.
 */
const ADAPTER_PARTITION_PREFIX = `HIST${SORT_KEY_SEPARATOR}`;

/** Partition key for a chat session: the adapter tag plus the session id. */
export function sessionPartition(sessionId: string): string {
  return `${ADAPTER_PARTITION_PREFIX}${sessionId}`;
}

/** Sort key for a single message item, ordered by its monotonic ULID. */
export function messageSortKey(ulid: string): string {
  return `${MESSAGE_PREFIX}${ulid}`;
}

/** `begins_with` prefix selecting every message item in a session. */
export function messageSortKeyPrefix(): string {
  return MESSAGE_PREFIX;
}
