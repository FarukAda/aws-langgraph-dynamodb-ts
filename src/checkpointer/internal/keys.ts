/** Reserved separator joining sort-key segments; forbidden inside any segment. */
export const SORT_KEY_SEPARATOR = '#';

/** Fixed digit width for the WRITE index so sort keys order numerically. */
const WRITE_INDEX_PAD_WIDTH = 10;

/**
 * Added to every write index before padding so the special negative slots from
 * `WRITES_IDX_MAP` (-1 ERROR .. -4 RESUME) encode as non-negative, sortable
 * integers that order below positional (0+) writes.
 */
const WRITE_INDEX_OFFSET = 8;

/** Sort-key kinds for the checkpoints table (the approved SK separation). */
enum CheckpointItemKind {
  META = 'META',
  PAYLOAD = 'PAYLOAD',
  WRITE = 'WRITE',
}

/** Partition key for a thread: the thread id itself. */
export function partitionKey(threadId: string): string {
  return threadId;
}

/** Sort key for a checkpoint's lightweight metadata item. */
export function metaSortKey(checkpointNs: string, checkpointId: string): string {
  return `${CheckpointItemKind.META}${SORT_KEY_SEPARATOR}${checkpointNs}${SORT_KEY_SEPARATOR}${checkpointId}`;
}

/** `begins_with` prefix selecting every META item in a namespace (for list). */
export function metaSortKeyPrefix(checkpointNs: string): string {
  return `${CheckpointItemKind.META}${SORT_KEY_SEPARATOR}${checkpointNs}${SORT_KEY_SEPARATOR}`;
}

/** Sort key for a checkpoint's heavy payload item. */
export function payloadSortKey(checkpointNs: string, checkpointId: string): string {
  return `${CheckpointItemKind.PAYLOAD}${SORT_KEY_SEPARATOR}${checkpointNs}${SORT_KEY_SEPARATOR}${checkpointId}`;
}

/** Sort key for a single pending write. */
export function writeSortKey(
  checkpointNs: string,
  checkpointId: string,
  taskId: string,
  index: number,
): string {
  const paddedIndex = (index + WRITE_INDEX_OFFSET).toString().padStart(WRITE_INDEX_PAD_WIDTH, '0');
  return [CheckpointItemKind.WRITE, checkpointNs, checkpointId, taskId, paddedIndex].join(
    SORT_KEY_SEPARATOR,
  );
}

/** `begins_with` prefix selecting every WRITE item for one checkpoint. */
export function writeSortKeyPrefix(checkpointNs: string, checkpointId: string): string {
  return `${CheckpointItemKind.WRITE}${SORT_KEY_SEPARATOR}${checkpointNs}${SORT_KEY_SEPARATOR}${checkpointId}${SORT_KEY_SEPARATOR}`;
}
