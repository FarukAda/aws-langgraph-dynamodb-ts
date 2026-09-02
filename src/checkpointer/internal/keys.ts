import { MAX_SORT_KEY_BYTES } from '../../shared/constants';
import { ValidationError } from '../../shared/errors/errors';

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

/**
 * The most negative write index the sort key can encode, `-WRITE_INDEX_OFFSET`.
 * A static test pins it against the peer's `WRITES_IDX_MAP`, so a peer bump
 * that adds a more negative special slot fails loudly instead of producing
 * unsortable keys.
 */
export const MIN_ENCODABLE_WRITE_INDEX = -WRITE_INDEX_OFFSET;

/** Sort-key kinds for the checkpoints table (the approved SK separation). */
enum CheckpointItemKind {
  META = 'META',
  PAYLOAD = 'PAYLOAD',
  WRITE = 'WRITE',
}

/**
 * Adapter tag prefixed to every checkpointer partition key. Without it a
 * `thread_id` reused as a `sessionId` or a store namespace root — an ordinary
 * design choice — put all three adapters' rows in one partition on a table
 * shared via `DynamoDBFactory.createAll()`, where a partition-wide delete
 * reached another adapter's data and composed sort keys could collide
 * byte-for-byte. The three tags differ in their first character, so the key
 * spaces are disjoint by construction.
 */
const ADAPTER_PARTITION_PREFIX = `CHKPT${SORT_KEY_SEPARATOR}`;

/** Partition key for a thread: the adapter tag plus the thread id. */
export function partitionKey(threadId: string): string {
  return `${ADAPTER_PARTITION_PREFIX}${threadId}`;
}

/** Sort key for a checkpoint's lightweight metadata item. */
export function metaSortKey(checkpointNs: string, checkpointId: string): string {
  return `${CheckpointItemKind.META}${SORT_KEY_SEPARATOR}${checkpointNs}${SORT_KEY_SEPARATOR}${checkpointId}`;
}

/** `begins_with` prefix selecting every META item in a namespace (for list). */
export function metaSortKeyPrefix(checkpointNs: string): string {
  return `${CheckpointItemKind.META}${SORT_KEY_SEPARATOR}${checkpointNs}${SORT_KEY_SEPARATOR}`;
}

/** `begins_with` prefix selecting every META item of a thread, whatever its namespace. */
export function metaAnyNamespacePrefix(): string {
  return `${CheckpointItemKind.META}${SORT_KEY_SEPARATOR}`;
}

/** Sort key for a checkpoint's heavy payload item. */
export function payloadSortKey(checkpointNs: string, checkpointId: string): string {
  return `${CheckpointItemKind.PAYLOAD}${SORT_KEY_SEPARATOR}${checkpointNs}${SORT_KEY_SEPARATOR}${checkpointId}`;
}

/**
 * Sort key for a single pending write. The trailing `channel` segment is what
 * keeps two *different* channels from ever occupying one row: without it, a
 * retried task whose write mix changed could compute an index another
 * channel already holds, and the first-write-wins guard — which cannot tell a
 * genuine retry from an unrelated write — would silently discard it. The
 * channel is appended verbatim as the final segment, so two sort keys collide
 * only when their channels are byte-identical; `writeSortKeyPrefix` stops at
 * the checkpoint id, ahead of this segment, so `begins_with` reads are
 * unaffected.
 */
export function writeSortKey(
  checkpointNs: string,
  checkpointId: string,
  taskId: string,
  index: number,
  channel: string,
): string {
  const offsetIndex = index + WRITE_INDEX_OFFSET;
  if (offsetIndex < 0 || offsetIndex.toString().length > WRITE_INDEX_PAD_WIDTH) {
    throw new ValidationError(
      `write index ${index} is outside the range encodable at offset ${WRITE_INDEX_OFFSET} ` +
        `with ${WRITE_INDEX_PAD_WIDTH} digits`,
      'index',
    );
  }
  const paddedIndex = offsetIndex.toString().padStart(WRITE_INDEX_PAD_WIDTH, '0');
  const sortKey = [
    CheckpointItemKind.WRITE,
    checkpointNs,
    checkpointId,
    taskId,
    paddedIndex,
    channel,
  ].join(SORT_KEY_SEPARATOR);
  const bytes = Buffer.byteLength(sortKey, 'utf8');
  if (bytes > MAX_SORT_KEY_BYTES) {
    throw new ValidationError(
      `checkpoint_ns, checkpoint_id, taskId and channel compose a ${bytes}-byte sort key; ` +
        `DynamoDB caps sort keys at ${MAX_SORT_KEY_BYTES} bytes`,
      'sortKey',
    );
  }
  return sortKey;
}

/**
 * True when `sortKey` is one this adapter writes. A partition query carries no
 * sort-key condition, so a partition-wide delete uses this to leave any row it
 * does not own in place rather than deleting the whole partition blindly.
 */
export function isCheckpointerSortKey(sortKey: string): boolean {
  return Object.values(CheckpointItemKind).some((kind) =>
    sortKey.startsWith(`${kind}${SORT_KEY_SEPARATOR}`),
  );
}

/** `begins_with` prefix selecting every WRITE item for one checkpoint. */
export function writeSortKeyPrefix(checkpointNs: string, checkpointId: string): string {
  return `${CheckpointItemKind.WRITE}${SORT_KEY_SEPARATOR}${checkpointNs}${SORT_KEY_SEPARATOR}${checkpointId}${SORT_KEY_SEPARATOR}`;
}
