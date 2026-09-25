/**
 * Hides the checkpointer's row format.
 *
 * A checkpoint is three kinds of row in its thread's partition — a light META
 * row a listing reads, a heavy PAYLOAD row, and one WRITE row per pending
 * write — and everything about how they are keyed, what they carry, and how a
 * checkpoint and its writes become rows and come back is decided here: the
 * sort-key segments and their order, the offset that lets the reserved negative
 * write indices sort as plain strings, the `writeGroup` and `occurrence` that
 * identify a write across calls, the recency-index keys a META row carries, and
 * which rows a read admits as this adapter's own. Nothing else composes or
 * splits a checkpointer key.
 */

import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointPendingWrite,
  PendingWrite,
  PendingWriteValue,
} from '@langchain/langgraph-checkpoint';
import { WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint';

import { nowIso } from '../../shared/clock';
import {
  codecDepsOf,
  collectS3Keys,
  decodePayload,
  encodePayload,
  type PayloadDescriptor,
} from '../../shared/codec/codec';
import { cleanUpS3Orphans } from '../../shared/codec/s3/offloader';
import { DEFAULT_READ_CONCURRENCY, mapWithConcurrency } from '../../shared/concurrency';
import type { AttributeMap } from '../../shared/dynamodb/client';
import { namedDescriptor, type NamedDescriptor } from '../../shared/dynamodb/partition-delete';
import {
  BACKFILLED_AT,
  DEFAULT_INDEX_SHARDS,
  indexKeys,
  type IndexTarget,
} from '../../shared/dynamodb/recency-index';
import {
  ADAPTER_TAGS,
  assertReadableRow,
  KEY_SEPARATOR,
  PARTITION_KEY_ATTRIBUTE,
  ROW_FORMAT_VERSION,
  type RowKey,
  SORT_KEY_ATTRIBUTE,
} from '../../shared/dynamodb/table-schema';
import { validationError } from '../../shared/errors/errors';
import { truncateForLog } from '../../shared/logging/truncate';
import { createUlidFactory } from '../../shared/ulid';
import type { CheckpointerContext } from './setup';

/** Where one stored checkpoint lives: from a parsed address, or from a row's own identifiers. */
export interface CheckpointLocation {
  readonly threadId: string;
  readonly checkpointNs: string;
  readonly checkpointId: string;
}

/** Where one pending write lives: its checkpoint, its task, its index and its channel. */
export interface WriteRowLocation {
  readonly checkpointNs: string;
  readonly checkpointId: string;
  readonly taskId: string;
  readonly index: number;
  readonly channel: string;
}

/** The lightweight `META#` item: structural fields + serialized metadata. */
export interface CheckpointMetaRow {
  PK: string;
  SK: string;
  /** Row format version; absent on rows written before it existed (see `table-schema.ts`). */
  v?: number;
  /** Recency-index keys; absent on rows written before the index existed. */
  gsi1pk?: string;
  gsi1sk?: string;
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
  parentCheckpointId?: string;
  metadata: PayloadDescriptor;
  ttl?: number;
}

/** The heavy `PAYLOAD#` item: the serialized checkpoint. */
export interface CheckpointPayloadRow {
  PK: string;
  SK: string;
  /** Row format version; absent on rows written before it existed (see `table-schema.ts`). */
  v?: number;
  checkpoint: PayloadDescriptor;
  ttl?: number;
}

/** A `WRITE#` item: one pending write for a checkpoint/task. */
export interface CheckpointWriteRow {
  PK: string;
  SK: string;
  /** Row format version; absent on rows written before it existed (see `table-schema.ts`). */
  v?: number;
  taskId: string;
  index: number;
  channel: string;
  /** Identifies the `putWrites` call that produced this row; see {@link WRITE_GROUP_ATTRIBUTE}. */
  writeGroup: string;
  /**
   * How many earlier writes in the same call already used this channel.
   * Optional: rows written before 0.9.0 carry none and read back as 0, which
   * is exactly the identity they were stored under.
   */
  occurrence?: number;
  value: PayloadDescriptor;
  ttl?: number;
}

/**
 * The attribute a WRITE row carries the id of the `putWrites` call that wrote
 * it in. A special write's compare-and-swap pins it, and a thread delete pins
 * a WRITE row's delete to it; a per-call ULID is already unique, so it needs no
 * separate revision attribute.
 */
export const WRITE_GROUP_ATTRIBUTE = 'writeGroup';

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
enum CheckpointRowKind {
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
const ADAPTER_PARTITION_PREFIX = `${ADAPTER_TAGS.checkpointer}${KEY_SEPARATOR}`;

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
  return `${CheckpointRowKind.META}${KEY_SEPARATOR}${checkpointNs}${KEY_SEPARATOR}${checkpointId}`;
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
  return `${CheckpointRowKind.META}${KEY_SEPARATOR}${checkpointNs}${KEY_SEPARATOR}`;
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
  return `${CheckpointRowKind.META}${KEY_SEPARATOR}`;
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
  return `${CheckpointRowKind.PAYLOAD}${KEY_SEPARATOR}${checkpointNs}${KEY_SEPARATOR}${checkpointId}`;
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
 * Accepts: `at` — the write's location: `at.index`, an integer (padding a
 * fraction produced `00000009.5`, which no longer orders numerically);
 * `at.channel`, separator-free, which `parseWriteChannel` establishes before
 * any key is built; `at.checkpointNs`, `at.checkpointId` and `at.taskId`, the
 * other parsed identifiers.
 *
 * Returns: the sort key, its index zero-padded to a fixed width so the special
 * negative slots order below the positional ones.
 *
 * Throws: `VALIDATION` naming `index` for an index this encoding cannot
 * represent.
 */
export function writeSortKey(at: WriteRowLocation): string {
  const offsetIndex = at.index + WRITE_INDEX_OFFSET;
  if (
    !Number.isInteger(offsetIndex) ||
    offsetIndex < 0 ||
    offsetIndex.toString().length > WRITE_INDEX_PAD_WIDTH
  ) {
    throw validationError(
      `write index ${at.index} is not an integer encodable at offset ${WRITE_INDEX_OFFSET} ` +
        `with ${WRITE_INDEX_PAD_WIDTH} digits`,
      'index',
    );
  }
  const paddedIndex = offsetIndex.toString().padStart(WRITE_INDEX_PAD_WIDTH, '0');
  return [
    CheckpointRowKind.WRITE,
    at.checkpointNs,
    at.checkpointId,
    at.taskId,
    paddedIndex,
    at.channel,
  ].join(KEY_SEPARATOR);
}

/**
 * The UTF-8 length of the WRITE sort key a write would get, without refusing
 * one over DynamoDB's cap.
 *
 * Accepts: `at` — the write's location without its index: `at.checkpointNs`,
 * `at.checkpointId`, `at.taskId` and `at.channel`, the four segments of a
 * WRITE sort key other than the index. The index is zero-padded to a fixed
 * width, so the length is the same for every index a write can take, and
 * index 0 stands for them all.
 *
 * Returns: the byte length DynamoDB measures the composed key by.
 *
 * Throws: nothing.
 */
export function writeSortKeyBytes(at: Omit<WriteRowLocation, 'index'>): number {
  return Buffer.byteLength(writeSortKey({ ...at, index: 0 }), 'utf8');
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
  return Object.values(CheckpointRowKind).some((kind) =>
    sortKey.startsWith(`${kind}${KEY_SEPARATOR}`),
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
  return `${CheckpointRowKind.WRITE}${KEY_SEPARATOR}${checkpointNs}${KEY_SEPARATOR}${checkpointId}${KEY_SEPARATOR}`;
}

/**
 * The key of one checkpoint's META row.
 *
 * Accepts: `at` — the checkpoint's thread, namespace and id.
 *
 * Returns: the row's partition and sort key.
 *
 * Throws: nothing.
 */
export function metaRowKey(at: CheckpointLocation): RowKey {
  return { PK: partitionKey(at.threadId), SK: metaSortKey(at.checkpointNs, at.checkpointId) };
}

/**
 * The key of one checkpoint's PAYLOAD row.
 *
 * Accepts: `at` — the checkpoint's thread, namespace and id.
 *
 * Returns: the row's partition and sort key.
 *
 * Throws: nothing.
 */
export function payloadRowKey(at: CheckpointLocation): RowKey {
  return { PK: partitionKey(at.threadId), SK: payloadSortKey(at.checkpointNs, at.checkpointId) };
}

/** Options for {@link partitionQuery}. */
export interface PartitionQueryOptions {
  consistent?: boolean;
}

/** Options for {@link beginsWithQuery}. */
export interface BeginsWithQueryOptions {
  limit?: number;
  /** Inclusive upper bound on the sort key; turns the prefix match into a `BETWEEN`. */
  beforeSortKey?: string;
  ascending?: boolean;
  consistent?: boolean;
}

/**
 * Query input selecting every item in a thread's partition.
 *
 * Accepts: the thread whose partition to read.
 *
 * Returns: the Query input, with no sort-key condition: it selects this
 * adapter's META, PAYLOAD and WRITE rows and any row another adapter left in
 * the partition — which is why every caller filters with
 * `isCheckpointerSortKey`.
 *
 * Throws: nothing.
 */
export function partitionQuery(
  tableName: string,
  partition: string,
  options: PartitionQueryOptions = {},
): QueryCommandInput {
  const params: QueryCommandInput = {
    TableName: tableName,
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': PARTITION_KEY_ATTRIBUTE },
    ExpressionAttributeValues: { ':pk': partition },
  };
  if (options.consistent) params.ConsistentRead = true;
  return params;
}

/**
 * Query input for a `begins_with` sort-key prefix.
 *
 * Accepts: `options.ascending` — sort-key order; newest-first is the default
 * because that is what "the latest checkpoint" asks for. `options.limit` — rows
 * DynamoDB evaluates per page, not a total. `options.consistent` — for a read
 * whose answer a write depends on.
 *
 * Returns: the Query input.
 *
 * Throws: nothing.
 */
export function beginsWithQuery(
  tableName: string,
  partition: string,
  skPrefix: string,
  options: BeginsWithQueryOptions = {},
): QueryCommandInput {
  const bounded = options.beforeSortKey !== undefined;
  const params: QueryCommandInput = {
    TableName: tableName,
    KeyConditionExpression: bounded
      ? '#pk = :pk AND #sk BETWEEN :skPrefix AND :before'
      : '#pk = :pk AND begins_with(#sk, :skPrefix)',
    ExpressionAttributeNames: { '#pk': PARTITION_KEY_ATTRIBUTE, '#sk': SORT_KEY_ATTRIBUTE },
    ExpressionAttributeValues: {
      ':pk': partition,
      ':skPrefix': skPrefix,
      ...(bounded ? { ':before': options.beforeSortKey } : {}),
    },
    ScanIndexForward: options.ascending ?? false,
  };
  // DynamoDB requires `Limit` to be at least 1 and rejects anything lower with
  // a raw `ValidationException`. A caller asking for nothing is answered
  // before a request is built (see `listCheckpoints`), so a non-positive value
  // reaching here means no page size was intended.
  if (options.limit !== undefined && options.limit >= 1) params.Limit = options.limit;
  if (options.consistent) params.ConsistentRead = true;
  return params;
}

/** What a checkpoint's META and PAYLOAD rows are built from. */
export interface CheckpointRowsSource {
  readonly address: CheckpointLocation;
  readonly parentCheckpointId: string | undefined;
  readonly checkpoint: Checkpoint;
  readonly metadata: CheckpointMetadata;
  readonly signal: AbortSignal | undefined;
}

/** What one call's WRITE rows are built from. */
export interface WriteRowsSource {
  readonly address: CheckpointLocation;
  readonly taskId: string;
  readonly writes: PendingWrite[];
  readonly signal: AbortSignal | undefined;
}

function withTtl<T extends { ttl?: number }>(item: T, ttlTimestamp?: number): T {
  if (ttlTimestamp !== undefined) item.ttl = ttlTimestamp;
  return item;
}

/**
 * Release the objects a build had already uploaded when a later payload of the
 * same build threw.
 *
 * Each payload uploads as it encodes, well before the row that would name it is
 * written, so a build that throws partway leaves the payloads it had already
 * finished with nothing pointing at them. Deleting them unconditionally — with
 * no read of the table first — is safe for two independent reasons.
 *
 * The descriptors released here never escape the builder: they are locals it
 * surrenders only at its `return`, which a build that throws never reaches, so
 * nothing anywhere has ever been handed one to copy onto a row. That holds
 * whatever the keys look like. Second, and only as a backstop to it, every key
 * ends in an `objectId` drawn for this call alone, so no row another call
 * commits addresses the same object.
 *
 * Best-effort, and it never replaces the failure that caused it: a caller needs
 * to see why its payload was refused, not why a cleanup could not finish.
 */
async function releaseUploads(
  context: CheckpointerContext,
  uploaded: readonly PayloadDescriptor[],
  operation: string,
): Promise<void> {
  if (!context.offloader) return;
  await cleanUpS3Orphans(context.offloader, {
    keys: collectS3Keys(uploaded),
    operation,
    logger: context.logger,
  });
}

/**
 * Names the objects of one `saver.put`. A ULID rather than a UUID because it
 * sorts by time, which keeps a bucket listing of one checkpoint's objects
 * readable.
 */
const nextPutObjectId = createUlidFactory();

/**
 * Encode a checkpoint + metadata into its META and PAYLOAD items.
 *
 * Each call draws one object id and uploads both offloaded payloads under it,
 * below the row that points at each. A second put of the same checkpoint id — a
 * put the caller re-issues after a lost response, or a repair tool re-writing a
 * checkpoint — draws another, so it never names an object the first put
 * uploaded, and the verification after a failed transaction can tell the two
 * puts' rows apart by the key alone.
 *
 * Accepts: `request` — parsed by `parsePutRequest`: the address the rows are
 * keyed by (its `checkpointId` is `checkpoint.id`), the parent, the checkpoint
 * — every channel value it carries is stored; see `putCheckpoint` for why
 * nothing is narrowed away — the metadata, and the signal that cancels the
 * uploads. `ttlTimestamp` — stamped on both rows so they expire together.
 *
 * Returns: the META row (light: ids, metadata, index keys) and the PAYLOAD row
 * (heavy: the checkpoint itself), which the caller writes in that order —
 * payload first, so a META row never names a payload that is not there yet.
 *
 * Throws: `VALIDATION` naming `value` for a checkpoint the serializer cannot
 * represent; `S3_OFFLOAD_FAILED` when an offloaded payload cannot be uploaded.
 * Encoding precedes every write, so a checkpoint that cannot be stored never
 * half-writes a thread — and a metadata payload refused after the checkpoint's
 * own object has uploaded releases that object before the failure leaves here
 * (see {@link releaseUploads}), so a refusal strands nothing either.
 */
export async function buildCheckpointRows(
  context: CheckpointerContext,
  request: CheckpointRowsSource,
  ttlTimestamp?: number,
): Promise<{ meta: CheckpointMetaRow; payload: CheckpointPayloadRow }> {
  const { threadId, checkpointNs, checkpointId } = request.address;
  const deps = codecDepsOf(context, request.signal);
  const pk = partitionKey(threadId);
  const objectId = nextPutObjectId();
  const checkpointDescriptor = await encodePayload(request.checkpoint, deps, {
    keyParts: [threadId, checkpointNs, checkpointId, 'checkpoint'],
    objectId,
    row: { pk, sk: payloadSortKey(checkpointNs, checkpointId) },
  });
  /**
   * The checkpoint's object is already uploaded by the time the metadata is
   * encoded, so a metadata payload the serde refuses — or cannot represent —
   * would otherwise strand it: the transaction that would have named it never
   * goes out. See {@link releaseUploads} for why deleting it needs no check.
   */
  let metadataDescriptor: PayloadDescriptor;
  try {
    metadataDescriptor = await encodePayload(request.metadata, deps, {
      keyParts: [threadId, checkpointNs, checkpointId, 'metadata'],
      objectId,
      row: { pk, sk: metaSortKey(checkpointNs, checkpointId) },
    });
  } catch (error) {
    await releaseUploads(context, [checkpointDescriptor], 'put.encode');
    throw error;
  }
  /**
   * The META row takes part in the recency index, so that a `saver.list`
   * without a `thread_id` can stream checkpoints across threads from the index,
   * newest first, instead of scanning the table, when `indexName` is set. The
   * PAYLOAD and WRITE rows do not: nothing lists them across partitions, and
   * indexing them would pay an extra write for an access pattern that does not
   * exist.
   */
  const index = indexKeys(
    'CHKPT',
    checkpointId,
    nowIso(),
    context.indexShards ?? DEFAULT_INDEX_SHARDS,
  );
  const meta: CheckpointMetaRow = {
    PK: pk,
    SK: metaSortKey(checkpointNs, checkpointId),
    v: ROW_FORMAT_VERSION,
    ...index,
    threadId,
    checkpointNs,
    checkpointId,
    metadata: metadataDescriptor,
  };
  if (request.parentCheckpointId !== undefined)
    meta.parentCheckpointId = request.parentCheckpointId;
  const payload: CheckpointPayloadRow = {
    PK: pk,
    SK: payloadSortKey(checkpointNs, checkpointId),
    v: ROW_FORMAT_VERSION,
    checkpoint: checkpointDescriptor,
  };
  return { meta: withTtl(meta, ttlTimestamp), payload: withTtl(payload, ttlTimestamp) };
}

/**
 * Encode a task's pending writes into one item per write.
 *
 * Accepts: `request` — parsed by `parsePutWritesRequest`, so every channel is
 * well-formed and every composed sort key fits before this runs, and a bad one
 * costs no S3 object. `writeGroup` — unique per `putWrites` *call*, not per
 * write, and stored on every row the call produces: it is what tells one
 * call's writes apart from another's when `dropSupersededWrites` resolves
 * first-write-wins, and it is the object id every offloaded write of the call
 * is uploaded under. Two calls writing the same bytes for the same row
 * therefore upload two objects, and each row names only its own call's.
 * `ttlTimestamp` — stamped on every row.
 *
 * Returns: one row per write, special channels first, each carrying its
 * `occurrence` so a channel emitted twice by one call keeps both values.
 *
 * Throws: `VALIDATION` naming `value`; `S3_OFFLOAD_FAILED`. A payload refused
 * partway through releases the objects the earlier writes of the same call had
 * already uploaded (see {@link releaseUploads}), so a build that throws
 * returns the caller to where it started.
 */
export async function buildWriteRows(
  context: CheckpointerContext,
  request: WriteRowsSource,
  writeGroup: string,
  ttlTimestamp?: number,
): Promise<CheckpointWriteRow[]> {
  const { threadId, checkpointNs, checkpointId } = request.address;
  const { taskId } = request;
  const deps = codecDepsOf(context, request.signal);
  const pk = partitionKey(threadId);
  const items: CheckpointWriteRow[] = [];
  // The writes upload one after another, so a payload refused at write N would
  // otherwise strand writes 1..N-1's objects: this call returns no items and
  // therefore writes no rows, leaving nothing that names them. See
  // {@link releaseUploads} for why they are safe to delete unconditionally.
  try {
    for (const { channel, value, index, occurrence } of resolveWriteIndices(request.writes)) {
      /**
       * `channel` is part of the key as well as the index: two channels can
       * share an index (each channel's first occurrence is 0), so without it
       * their uploads would collide on one S3 object within a single call.
       */
      const sk = writeSortKey({ checkpointNs, checkpointId, taskId, index, channel });
      const descriptor = await encodePayload(value, deps, {
        keyParts: [threadId, checkpointNs, checkpointId, taskId, `write-${index}`, channel],
        objectId: writeGroup,
        row: { pk, sk },
      });
      const item: CheckpointWriteRow = {
        PK: pk,
        SK: sk,
        v: ROW_FORMAT_VERSION,
        taskId,
        index,
        channel,
        /**
         * Shared by every row this call writes. Positions shift when a retried
         * task's write mix changes, so a channel an earlier call already
         * committed can land at a second index and be replayed twice; the group
         * is what lets the read side tell that apart from a channel a single
         * call legitimately wrote more than once.
         */
        writeGroup,
        occurrence,
        value: descriptor,
      };
      items.push(withTtl(item, ttlTimestamp));
    }
  } catch (error) {
    await releaseUploads(
      context,
      items.map((item) => item.value),
      'putWrites.encode',
    );
    throw error;
  }
  return items;
}

/**
 * Narrow a raw row to a {@link CheckpointMetaRow}.
 *
 * Accepts: `raw` — any row carrying the `META#` sort-key prefix, which on a
 * shared table another writer can produce too.
 *
 * Returns: the item, or undefined for a row that merely shares the prefix, and
 * for one whose own `threadId`/`checkpointNs`/`checkpointId` disagree with the
 * DynamoDB key it was found at. The test is on the attributes a checkpoint must
 * have, not on a cast: this is the one boundary where a row may not have been
 * written by this adapter. A `metadata` of `null` is refused here, since
 * dereferencing it later raised a raw `TypeError`.
 *
 * Throws: `FORMAT_UNSUPPORTED` for a row a newer version wrote — checked
 * **before** the shape, as every other read of this package's rows checks it,
 * so a row a newer release wrote is reported as newer rather than judged
 * against attribute names it may no longer use. Skipping it would report a
 * thread as shorter than it is.
 *
 * Guarantees: a row's attributes are bound to the partition it lives in. Those
 * attributes name the S3 scope the row's payloads are read under and the thread
 * the assembled tuple reports, so a writer confined to its own partition could
 * otherwise hand back another tenant's offloaded payload under that tenant's
 * `thread_id` — the same binding `parseStoreRow` makes for store items. The
 * binding is judged under this release's rules, which is why it is judged only
 * for a row this release can read.
 */
export function parseMetaRow(raw: AttributeMap): CheckpointMetaRow | undefined {
  // The version first. A row a newer version wrote is not a foreign row to
  // skip, and this release's names for its attributes are not that release's,
  // so testing the shape first decides a row is foreign whenever a later
  // format renamed what this one reads.
  assertReadableRow(raw, 'checkpoint');
  const isCheckpoint =
    typeof raw.threadId === 'string' &&
    typeof raw.checkpointId === 'string' &&
    typeof raw.checkpointNs === 'string' &&
    typeof raw.metadata === 'object' &&
    raw.metadata !== null;
  if (!isCheckpoint) return undefined;
  const item = raw as CheckpointMetaRow;
  const consistent =
    item.PK === partitionKey(item.threadId) &&
    item.SK === metaSortKey(item.checkpointNs, item.checkpointId);
  return consistent ? item : undefined;
}

/**
 * Narrow a candidate head row, saying so when it is not one of ours.
 *
 * Accepts: `raw` — the row a newest-first read returned, or undefined when it
 * returned none.
 *
 * Returns: the item, or undefined for an absent or foreign row — logged at
 * `warn` in the second case, because a foreign row at the head of a thread is
 * an operator's problem even though this read recovers from it.
 *
 * Throws: as {@link parseMetaRow}.
 *
 * Guarantees: a foreign row is skipped, never returned. Returning one made
 * `assembleTuple` miss its payload and report the thread as empty, so LangGraph
 * started a new run on top of the real history.
 */
export function parseHeadRow(
  context: CheckpointerContext,
  raw: AttributeMap | undefined,
): CheckpointMetaRow | undefined {
  if (raw === undefined) return undefined;
  const meta = parseMetaRow(raw);
  if (!meta) {
    context.logger.warn('getTuple: skipped a row that is not a checkpoint meta item', {
      sortKey: truncateForLog(raw.SK as string),
    });
  }
  return meta;
}

/**
 * Decode the checkpoint stored in a PAYLOAD item.
 *
 * Accepts: `threadId` — the **caller's**, from the config, never the row's: it
 * scopes which S3 object the row may point at, so it must come from the
 * partition the caller asked for. A row that names an object outside that scope
 * is refused by the codec rather than downloaded. `signal` — cancels the
 * download an offloaded payload costs.
 *
 * Returns: the checkpoint.
 *
 * Throws: `PAYLOAD_CORRUPT` for bytes that cannot be decoded, `VALIDATION`
 * for a descriptor pointing outside the row's scope and for a payload the
 * configured serde refuses to reconstruct, and whatever the download throws.
 */
export async function readCheckpoint(
  context: CheckpointerContext,
  item: CheckpointPayloadRow,
  threadId: string,
  signal?: AbortSignal,
): Promise<Checkpoint> {
  return decodePayload<Checkpoint>(item.checkpoint, codecDepsOf(context, signal), [threadId]);
}

/**
 * Decode the metadata stored in a META item.
 *
 * Accepts: as {@link readCheckpoint}, for the metadata blob instead of the
 * checkpoint.
 *
 * Returns: the metadata.
 *
 * Throws: as {@link readCheckpoint}.
 */
export async function readMetadata(
  context: CheckpointerContext,
  item: CheckpointMetaRow,
  threadId: string,
  signal?: AbortSignal,
): Promise<CheckpointMetadata> {
  return decodePayload<CheckpointMetadata>(item.metadata, codecDepsOf(context, signal), [threadId]);
}

/**
 * Decode WRITE items into `[taskId, channel, value]` pending-write tuples.
 *
 * Accepts: `items` — one checkpoint's WRITE rows, in any order; empty is empty.
 * `threadId` — the caller's, as in {@link readCheckpoint}. `signal` — cancels
 * the downloads, all of which share it.
 *
 * Returns: the writes LangGraph replays, first-write-wins already resolved by
 * `dropSupersededWrites`, in the order the surviving rows were read.
 *
 * Throws: whatever a decode throws — the first one, with the rest allowed to
 * settle.
 *
 * Guarantees: payloads decode several at a time, so a checkpoint with many
 * offloaded writes costs one round of downloads rather than one per write.
 */
export async function toPendingWrites(
  context: CheckpointerContext,
  items: CheckpointWriteRow[],
  threadId: string,
  signal?: AbortSignal,
): Promise<CheckpointPendingWrite[]> {
  const deps = codecDepsOf(context, signal);
  const live = dropSupersededWrites(items);
  const values = await mapWithConcurrency(
    live,
    context.readConcurrency ?? DEFAULT_READ_CONCURRENCY,
    (item) => decodePayload(item.value, deps, [threadId]),
  );
  return live.map((item, index): CheckpointPendingWrite => [
    item.taskId,
    item.channel,
    values[index],
  ]);
}

/** One write with its sort-key index resolved exactly once. */
export interface ResolvedWrite {
  channel: string;
  value: PendingWriteValue;
  index: number;
  /**
   * How many earlier writes in this same call already used this channel. A
   * retry that emits a channel *more* often than the original call produces a
   * row at an occurrence no earlier call ever wrote — it collides with nothing
   * and commits cleanly, so the read-side dedup must not mistake it for a
   * superseding duplicate.
   */
  occurrence: number;
}

/**
 * Assign every write in one `putWrites` call its sort-key index, in a single
 * pass — nothing recomputes it downstream, so the deduped array's positions
 * cannot disagree with the ones the caller's array produced.
 *
 * A regular write's index is its position in the caller's array, exactly as
 * the reference `MemorySaver` computes it: that is what makes stored writes
 * replay in the order the task emitted them. A special channel takes its
 * fixed `WRITES_IDX_MAP` slot instead, and a later duplicate replaces an
 * earlier one (last-write-wins, again matching the reference).
 *
 * Positions are not stable across calls, which is why the *sort key* also
 * carries the channel and each call stamps its rows with a shared
 * `writeGroup` — see {@link buildWriteRows} and `dropSupersededWrites`.
 *
 * `Object.hasOwn` guards WRITES_IDX_MAP's own `Object.prototype` chain — a
 * channel literally named `constructor`/`toString`/etc. must be treated as
 * regular, not resolve to an inherited function reference.
 *
 * Accepts: `writes` — one `putWrites` call's writes, already validated for
 * channel shape; empty is empty.
 *
 * Returns: the special writes first, then the regular ones. A special channel
 * appearing twice yields one entry (the last), a regular channel appearing
 * twice yields two, distinguished by `occurrence`.
 *
 * Throws: nothing.
 *
 * Guarantees: within one call, `(channel, occurrence)` is unique — which is
 * what lets `dropSupersededWrites` treat it as an identity across calls.
 */
export function resolveWriteIndices(writes: PendingWrite[]): ResolvedWrite[] {
  const bySpecialIndex = new Map<number, ResolvedWrite>();
  const regular: ResolvedWrite[] = [];
  const occurrences = new Map<string, number>();
  writes.forEach(([channel, value], positional) => {
    if (Object.hasOwn(WRITES_IDX_MAP, channel)) {
      const index = WRITES_IDX_MAP[channel];
      // Last write wins per special channel, so a call holds exactly one.
      bySpecialIndex.set(index, { channel, value, index, occurrence: 0 });
      return;
    }
    const occurrence = occurrences.get(channel) ?? 0;
    occurrences.set(channel, occurrence + 1);
    regular.push({ channel, value, index: positional, occurrence });
  });
  return [...bySpecialIndex.values(), ...regular];
}

/**
 * Resolve a task's pending writes to one row per `(taskId, channel,
 * occurrence)`, keeping the earliest `putWrites` call that wrote it.
 *
 * A regular write's index is its position in the caller's array, so a retried
 * task whose write mix changed places an already-committed channel at a
 * different index, where the first-write-wins guard cannot recognise it and a
 * second row commits. Replaying both double-counts an accumulating channel.
 * Each call stamps its rows with one `writeGroup`, and the earliest group per
 * identity is the call that actually won.
 *
 * `occurrence` is part of the identity so a retry that legitimately emits a
 * channel *more* often than the original keeps both values, which is what
 * `MemorySaver` does when it keys first-write-wins on `(taskId, index)`.
 *
 * Accepts: `items` — the WRITE rows of one checkpoint, in any order; empty is
 * empty. A row written before `writeGroup` or `occurrence` existed carries
 * neither, and both are normalised at the edge rather than tested for.
 *
 * Returns: the rows to replay, in the order given. One per `(taskId, channel,
 * occurrence)`: the row whose `writeGroup` sorts earliest, which is the call
 * that actually won the first-write-wins guard.
 *
 * Throws: nothing.
 *
 * Guarantees: exactly one row survives per identity. Two rows could tie only by
 * sharing a `writeGroup` as well, and one call assigns each of its channels a
 * distinct `occurrence`, so within a call the identity is already unique.
 */
export function dropSupersededWrites(items: CheckpointWriteRow[]): CheckpointWriteRow[] {
  const identity = (item: CheckpointWriteRow): string =>
    JSON.stringify([item.taskId, item.channel, item.occurrence ?? 0]);
  /**
   * The call a row belongs to, as something orderable. A row written before
   * `writeGroup` existed carries none and is older than every row that does —
   * the empty string sorts before any ULID.
   *
   * Keeping the raw `undefined` reversed first-write-wins across an upgrade: a
   * `Map` cannot tell a key whose value is absent from one whose value *is*
   * `undefined`, so the guard that checks "nothing recorded yet" fired again on
   * the pre-upgrade row's own entry and let the next, newer row overwrite it.
   * Normalising at the edge removes the ambiguity instead of testing for it.
   */
  const groupOf = (item: CheckpointWriteRow): string => item.writeGroup ?? '';
  const earliestGroup = new Map<string, string>();
  for (const item of items) {
    const id = identity(item);
    const seen = earliestGroup.get(id);
    const group = groupOf(item);
    if (seen === undefined || group < seen) earliestGroup.set(id, group);
  }
  return items.filter((item) => earliestGroup.get(identity(item)) === groupOf(item));
}

/** The attributes a checkpointer row can hold an offloaded payload under. */
const PAYLOAD_ATTRIBUTES = ['metadata', 'checkpoint', 'value'] as const;

/**
 * The offloaded payloads a checkpointer row references, each named by the
 * attribute holding it, because a row is pinned through a document path over
 * that name.
 *
 * Accepts: `row` — a row of this adapter's partition.
 *
 * Returns: the descriptors, each named by its attribute. An attribute the row
 * leaves out and one it holds `null` in both name no payload, which is what
 * `namedDescriptor` decides.
 *
 * Throws: nothing.
 */
export function checkpointRowDescriptors(row: AttributeMap): NamedDescriptor[] {
  const named: NamedDescriptor[] = [];
  for (const attribute of PAYLOAD_ATTRIBUTES) {
    const entry = namedDescriptor(row, attribute);
    if (entry !== undefined) named.push(entry);
  }
  return named;
}

/**
 * The checkpoint a row belongs to.
 *
 * Accepts: `row` — a row of this adapter's partition.
 *
 * Returns: the `ns#id` unit: the namespace and id its sort key carries in the
 * same two segments whatever its kind, which is exact rather than hopeful
 * because the separator is forbidden inside every segment.
 *
 * Throws: nothing.
 */
export function checkpointRowUnit(row: AttributeMap): string {
  return (row.SK as string).split(KEY_SEPARATOR).slice(1, 3).join(KEY_SEPARATOR);
}

/**
 * The row kind.
 *
 * Accepts: `row` — a row of this adapter's partition.
 *
 * Returns: the kind, which is the sort key's leading segment.
 *
 * Throws: nothing.
 */
export function checkpointRowKind(row: AttributeMap): string {
  return (row.SK as string).split(KEY_SEPARATOR)[0];
}

/**
 * Where a checkpointer row sits in the recency index, for a row written before
 * the index existed.
 *
 * Accepts: `row` — any row of the table.
 *
 * Returns: a META row's identity — its checkpoint id, at {@link BACKFILLED_AT},
 * because a META row records no time of its own — or `undefined` for any other
 * row, this adapter's or not.
 *
 * Throws: nothing.
 */
export function checkpointIndexTarget(row: AttributeMap): IndexTarget | undefined {
  const pk = typeof row.PK === 'string' ? row.PK : '';
  const sk = typeof row.SK === 'string' ? row.SK : '';
  if (!pk.startsWith(ADAPTER_PARTITION_PREFIX)) return undefined;
  return sk.startsWith(metaAnyNamespacePrefix()) && typeof row.checkpointId === 'string'
    ? { tag: 'CHKPT', id: row.checkpointId, at: BACKFILLED_AT }
    : undefined;
}
