import { validationError } from '../../shared/errors/errors';

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

/**
 * The tag every checkpointer partition key starts with.
 *
 * Accepts: nothing — the tag is fixed, and the function exists so no caller
 * composes it by hand.
 *
 * Returns: the tag, for a table-wide `begins_with` over this adapter's rows.
 *
 * Throws: nothing.
 */
export function checkpointerPartitionPrefix(): string {
  return ADAPTER_PARTITION_PREFIX;
}

/**
 * Partition key for a thread: the adapter tag plus the thread id.
 *
 * Accepts: `threadId` — normally validated, so it cannot contain the separator.
 *
 * Returns: the partition key. Total, like every key builder here: a row read
 * from a shared table is *tested* against these, so a malformed value must
 * compose a key that matches nothing rather than fail the read.
 *
 * Throws: nothing.
 */
export function partitionKey(threadId: string): string {
  return `${ADAPTER_PARTITION_PREFIX}${threadId}`;
}

/**
 * Sort key for a checkpoint's lightweight metadata item.
 *
 * Accepts: `checkpointNs` — possibly empty, which is the root namespace.
 * `checkpointId` — the checkpoint's own id.
 *
 * Returns: the sort key. The namespace sits above the id so a namespace's
 * checkpoints are contiguous and a `begins_with` selects exactly them.
 *
 * Throws: nothing.
 */
export function metaSortKey(checkpointNs: string, checkpointId: string): string {
  return `${CheckpointItemKind.META}${SORT_KEY_SEPARATOR}${checkpointNs}${SORT_KEY_SEPARATOR}${checkpointId}`;
}

/**
 * `begins_with` prefix selecting every META item in one namespace.
 *
 * Accepts: `checkpointNs` — the namespace to scope to; empty scopes to the root
 * namespace, not to every namespace.
 *
 * Returns: the prefix, separator-terminated, so the namespace `a` does not also
 * select `ab`.
 *
 * Throws: nothing.
 */
export function metaSortKeyPrefix(checkpointNs: string): string {
  return `${CheckpointItemKind.META}${SORT_KEY_SEPARATOR}${checkpointNs}${SORT_KEY_SEPARATOR}`;
}

/**
 * `begins_with` prefix selecting every META item of a thread.
 *
 * Accepts: nothing — the prefix is the same for every thread, because the
 * thread is already the partition.
 *
 * Returns: the kind prefix alone, so the selection spans every namespace of the
 * thread — what a `list` with no `checkpoint_ns` asks for.
 *
 * Throws: nothing.
 */
export function metaAnyNamespacePrefix(): string {
  return `${CheckpointItemKind.META}${SORT_KEY_SEPARATOR}`;
}

/**
 * Sort key for a checkpoint's heavy payload item.
 *
 * Accepts: as {@link metaSortKey}.
 *
 * Returns: the sort key of the row holding the checkpoint itself, which is
 * written before its META row and read only after one is found.
 *
 * Throws: nothing.
 */
export function payloadSortKey(checkpointNs: string, checkpointId: string): string {
  return `${CheckpointItemKind.PAYLOAD}${SORT_KEY_SEPARATOR}${checkpointNs}${SORT_KEY_SEPARATOR}${checkpointId}`;
}

/**
 * Sort key for a single pending write. The trailing `channel` segment is what
 * keeps two *different* channels from ever occupying one row: without it, a
 * retried task whose write mix changed could compute an index another channel
 * already holds, and the first-write-wins guard — which cannot tell a
 * genuine retry from an unrelated write — would silently discard it. The
 * channel is appended verbatim as the final segment, so two sort keys collide
 * only when their channels are byte-identical; `writeSortKeyPrefix` stops at
 * the checkpoint id, ahead of this segment, so `begins_with` reads are
 * unaffected.
 *
 * The composed length is not checked here: `parsePutWritesRequest` refuses a
 * write whose key would pass the cap, measured by {@link writeSortKeyBytes},
 * before anything is encoded.
 *
 * Accepts: `index` — an integer; padding a fraction produced `00000009.5`,
 * which no longer orders numerically. `channel` — separator-free, which
 * `parseWriteChannel` establishes before any key is built. The other segments
 * are the parsed identifiers.
 *
 * Returns: the sort key, its index zero-padded to a fixed width so the special
 * negative slots order below the positional ones.
 *
 * Throws: `VALIDATION` naming `index` for an index this encoding cannot
 * represent.
 */
export function writeSortKey(
  checkpointNs: string,
  checkpointId: string,
  taskId: string,
  index: number,
  channel: string,
): string {
  const offsetIndex = index + WRITE_INDEX_OFFSET;
  if (
    !Number.isInteger(offsetIndex) ||
    offsetIndex < 0 ||
    offsetIndex.toString().length > WRITE_INDEX_PAD_WIDTH
  ) {
    throw validationError(
      `write index ${index} is not an integer encodable at offset ${WRITE_INDEX_OFFSET} ` +
        `with ${WRITE_INDEX_PAD_WIDTH} digits`,
      'index',
    );
  }
  const paddedIndex = offsetIndex.toString().padStart(WRITE_INDEX_PAD_WIDTH, '0');
  return [CheckpointItemKind.WRITE, checkpointNs, checkpointId, taskId, paddedIndex, channel].join(
    SORT_KEY_SEPARATOR,
  );
}

/**
 * The UTF-8 length of the WRITE sort key a write would get, without refusing
 * one over DynamoDB's cap.
 *
 * Accepts: the four segments of a WRITE sort key other than the index. The
 * index is zero-padded to a fixed width, so the length is the same for every
 * index a write can take, and index 0 stands for them all.
 *
 * Returns: the byte length DynamoDB measures the composed key by.
 *
 * Throws: nothing.
 */
export function writeSortKeyBytes(
  checkpointNs: string,
  checkpointId: string,
  taskId: string,
  channel: string,
): number {
  return Buffer.byteLength(writeSortKey(checkpointNs, checkpointId, taskId, 0, channel), 'utf8');
}

/**
 * Whether `sortKey` is one this adapter writes.
 *
 * Accepts: any sort key read from a thread's partition.
 *
 * Returns: whether it starts with one of this adapter's kind tags. A partition
 * query carries no sort-key condition, so a partition-wide delete uses this to
 * leave a row it does not own in place rather than deleting the whole partition
 * blindly.
 *
 * Throws: nothing.
 */
export function isCheckpointerSortKey(sortKey: string): boolean {
  return Object.values(CheckpointItemKind).some((kind) =>
    sortKey.startsWith(`${kind}${SORT_KEY_SEPARATOR}`),
  );
}

/**
 * `begins_with` prefix selecting every WRITE item of one checkpoint.
 *
 * Accepts: the namespace and checkpoint the writes belong to.
 *
 * Returns: the prefix, separator-terminated, so one checkpoint's writes never
 * include another's whose id merely starts the same way.
 *
 * Throws: nothing.
 */
export function writeSortKeyPrefix(checkpointNs: string, checkpointId: string): string {
  return `${CheckpointItemKind.WRITE}${SORT_KEY_SEPARATOR}${checkpointNs}${SORT_KEY_SEPARATOR}${checkpointId}${SORT_KEY_SEPARATOR}`;
}
