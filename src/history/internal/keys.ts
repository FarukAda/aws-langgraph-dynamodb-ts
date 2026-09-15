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

/**
 * Partition key for a chat session: the adapter tag plus the session id.
 *
 * Accepts: `sessionId` — normally validated, so it cannot contain the
 * separator and the key is unambiguous.
 *
 * Returns: the partition key. A whole session lives in one partition, which is
 * what makes a session read one Query and a session delete one partition walk.
 *
 * Throws: nothing.
 */
export function sessionPartition(sessionId: string): string {
  return `${ADAPTER_PARTITION_PREFIX}${sessionId}`;
}

/**
 * Sort key for a single message item.
 *
 * Accepts: `ulid` — a monotonic ULID, or the time-prefix of one when the caller
 * is building a range bound rather than a key.
 *
 * Returns: the sort key. ULIDs sort lexicographically in time order, so the
 * sort key *is* the chronological order; nothing re-sorts messages on read.
 *
 * Throws: nothing.
 */
export function messageSortKey(ulid: string): string {
  return `${MESSAGE_PREFIX}${ulid}`;
}

/**
 * Whether `sortKey` is one this adapter writes.
 *
 * Accepts: any sort key read from the session's partition.
 *
 * Returns: whether this adapter owns the row. A partition query carries no
 * sort-key condition, so a partition-wide delete uses this to leave a row it
 * does not own in place rather than deleting the whole partition blindly.
 *
 * Throws: nothing.
 */
export function isHistorySortKey(sortKey: string): boolean {
  return sortKey.startsWith(ADAPTER_PREFIX);
}

/**
 * `begins_with` prefix selecting every message item in a session.
 *
 * Accepts: nothing — the prefix is the same for every session, because the
 * session is already the partition.
 *
 * Returns: the prefix, which excludes the SESSION metadata row: that row shares
 * the partition but is not a message.
 *
 * Throws: nothing.
 */
export function messageSortKeyPrefix(): string {
  return MESSAGE_PREFIX;
}
