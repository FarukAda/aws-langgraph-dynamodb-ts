const SEPARATOR = '#';

/** Sort-key kinds for the checkpoints table (the approved SK separation). */
export enum CheckpointItemKind {
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
  return `${CheckpointItemKind.META}${SEPARATOR}${checkpointNs}${SEPARATOR}${checkpointId}`;
}

/** `begins_with` prefix selecting every META item in a namespace (for list). */
export function metaSortKeyPrefix(checkpointNs: string): string {
  return `${CheckpointItemKind.META}${SEPARATOR}${checkpointNs}${SEPARATOR}`;
}

/** Sort key for a checkpoint's heavy payload item. */
export function payloadSortKey(checkpointNs: string, checkpointId: string): string {
  return `${CheckpointItemKind.PAYLOAD}${SEPARATOR}${checkpointNs}${SEPARATOR}${checkpointId}`;
}

/** Sort key for a single pending write. */
export function writeSortKey(
  checkpointNs: string,
  checkpointId: string,
  taskId: string,
  index: number,
): string {
  return [CheckpointItemKind.WRITE, checkpointNs, checkpointId, taskId, index].join(SEPARATOR);
}

/** `begins_with` prefix selecting every WRITE item for one checkpoint. */
export function writeSortKeyPrefix(checkpointNs: string, checkpointId: string): string {
  return `${CheckpointItemKind.WRITE}${SEPARATOR}${checkpointNs}${SEPARATOR}${checkpointId}${SEPARATOR}`;
}
