import type { Checkpoint, CheckpointMetadata, PendingWrite } from '@langchain/langgraph-checkpoint';

import { nowIso } from '../../shared/clock';
import { type CodecDeps, type PayloadDescriptor } from '../../shared/codec/codec';
import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { encodePayload } from '../../shared/codec/encode';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { DEFAULT_INDEX_SHARDS, indexKeys } from '../../shared/dynamodb/index-keys';
import { ROW_FORMAT_VERSION } from '../../shared/dynamodb/row-version';
import { createUlidFactory } from '../../shared/ulid';
import type { CheckpointMetaItem, CheckpointPayloadItem, CheckpointWriteItem } from '../types';
import { metaSortKey, partitionKey, payloadSortKey, writeSortKey } from './keys';
import type { CheckpointerContext } from './setup';
import { validateChannel } from './validation';
import { resolveWriteIndices } from './write-index';

/**
 * Map a context to the codec collaborators.
 *
 * Accepts: the adapter's context, and the caller's `signal` when the call has
 * one — a cleanup or verification path deliberately passes none.
 *
 * Returns: the three collaborators the codec needs — the serializer, the
 * compression config and the offloader — so a codec call names what it uses
 * rather than taking the whole context, plus the signal that decides whether
 * an offloaded payload's request may be cancelled.
 *
 * Throws: nothing.
 */
export function codecDeps(context: CheckpointerContext, signal?: AbortSignal): CodecDeps {
  return {
    serde: context.serde,
    compression: context.compression,
    offloader: context.offloader,
    signal,
  };
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
  await cleanUpS3Orphans(context.offloader, collectS3Keys(uploaded), operation, context.logger);
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
 * Accepts: `checkpoint` — every channel value it carries is stored; see
 * `putCheckpoint` for why nothing is narrowed away. `parentCheckpointId` — the
 * checkpoint this one continues, absent for a root. `ttlTimestamp` — stamped on
 * both rows so they expire together. `signal` — cancels the uploads.
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
export async function buildCheckpointItems(
  context: CheckpointerContext,
  threadId: string,
  checkpointNs: string,
  checkpoint: Checkpoint,
  metadata: CheckpointMetadata,
  parentCheckpointId?: string,
  ttlTimestamp?: number,
  signal?: AbortSignal,
): Promise<{ meta: CheckpointMetaItem; payload: CheckpointPayloadItem }> {
  const deps = codecDeps(context, signal);
  const pk = partitionKey(threadId);
  const objectId = nextPutObjectId();
  const checkpointDescriptor = await encodePayload(checkpoint, deps, {
    keyParts: [threadId, checkpointNs, checkpoint.id, 'checkpoint'],
    objectId,
    row: { pk, sk: payloadSortKey(checkpointNs, checkpoint.id) },
  });
  /**
   * The checkpoint's object is already uploaded by the time the metadata is
   * encoded, so a metadata payload the serde refuses — or cannot represent —
   * would otherwise strand it: the transaction that would have named it never
   * goes out. See {@link releaseUploads} for why deleting it needs no check.
   */
  let metadataDescriptor: PayloadDescriptor;
  try {
    metadataDescriptor = await encodePayload(metadata, deps, {
      keyParts: [threadId, checkpointNs, checkpoint.id, 'metadata'],
      objectId,
      row: { pk, sk: metaSortKey(checkpointNs, checkpoint.id) },
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
    checkpoint.id,
    nowIso(),
    context.indexShards ?? DEFAULT_INDEX_SHARDS,
  );
  const meta: CheckpointMetaItem = {
    PK: pk,
    SK: metaSortKey(checkpointNs, checkpoint.id),
    v: ROW_FORMAT_VERSION,
    ...index,
    threadId,
    checkpointNs,
    checkpointId: checkpoint.id,
    metadata: metadataDescriptor,
  };
  if (parentCheckpointId !== undefined) meta.parentCheckpointId = parentCheckpointId;
  const payload: CheckpointPayloadItem = {
    PK: pk,
    SK: payloadSortKey(checkpointNs, checkpoint.id),
    v: ROW_FORMAT_VERSION,
    checkpoint: checkpointDescriptor,
  };
  return { meta: withTtl(meta, ttlTimestamp), payload: withTtl(payload, ttlTimestamp) };
}

/**
 * Encode a task's pending writes into one item per write.
 *
 * Accepts: `writes` — one call's, in order; their channels are validated
 * before any payload is encoded or uploaded, so a bad channel costs no S3
 * object. `writeGroup` — unique per `putWrites` *call*, not per write, and
 * stored on every row the call produces: it is what tells one call's writes
 * apart from another's when `dropSupersededWrites` resolves first-write-wins,
 * and it is the object id every offloaded write of the call is uploaded under.
 * Two calls writing the same bytes for the same row therefore upload two
 * objects, and each row names only its own call's.
 *
 * `signal` — cancels the uploads.
 *
 * Returns: one row per write, special channels first, each carrying its
 * `occurrence` so a channel emitted twice by one call keeps both values.
 *
 * Throws: `VALIDATION` naming `channel` or `value`; `S3_OFFLOAD_FAILED`. A
 * payload refused partway through releases the objects the earlier writes of
 * the same call had already uploaded (see {@link releaseUploads}), so a build
 * that throws returns the caller to where it started.
 */
export async function buildWriteItems(
  context: CheckpointerContext,
  threadId: string,
  checkpointNs: string,
  checkpointId: string,
  taskId: string,
  writes: PendingWrite[],
  writeGroup: string,
  ttlTimestamp?: number,
  signal?: AbortSignal,
): Promise<CheckpointWriteItem[]> {
  /** Reject a bad channel before any payload is encoded or uploaded. */
  for (const [channel] of writes) validateChannel(channel);
  const deps = codecDeps(context, signal);
  const pk = partitionKey(threadId);
  const items: CheckpointWriteItem[] = [];
  /**
   * The writes upload one after another, so a payload refused at write N would
   * otherwise strand writes 1..N-1's objects: this call returns no items and
   * therefore writes no rows, leaving nothing that names them. See
   * {@link releaseUploads} for why they are safe to delete unconditionally.
   */
  try {
    for (const { channel, value, index, occurrence } of resolveWriteIndices(writes)) {
      /**
       * `channel` is part of the key as well as the index: two channels can
       * share an index (each channel's first occurrence is 0), so without it
       * their uploads would collide on one S3 object within a single call.
       */
      const sk = writeSortKey(checkpointNs, checkpointId, taskId, index, channel);
      const descriptor = await encodePayload(value, deps, {
        keyParts: [threadId, checkpointNs, checkpointId, taskId, `write-${index}`, channel],
        objectId: writeGroup,
        row: { pk, sk },
      });
      const item: CheckpointWriteItem = {
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
