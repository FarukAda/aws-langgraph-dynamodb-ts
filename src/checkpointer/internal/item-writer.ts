import type { Checkpoint, CheckpointMetadata, PendingWrite } from '@langchain/langgraph-checkpoint';

import { nowIso } from '../../shared/clock';
import { type CodecDeps } from '../../shared/codec/codec';
import { encodePayload } from '../../shared/codec/encode';
import { DEFAULT_INDEX_SHARDS, indexKeys } from '../../shared/dynamodb/index-keys';
import { ROW_FORMAT_VERSION } from '../../shared/dynamodb/row-version';
import type { CheckpointMetaItem, CheckpointPayloadItem, CheckpointWriteItem } from '../types';
import { metaSortKey, partitionKey, payloadSortKey, writeSortKey } from './keys';
import type { CheckpointerContext } from './setup';
import { validateChannel } from './validation';
import { resolveWriteIndices } from './write-index';

/**
 * Map a context to the codec collaborators.
 *
 * Accepts: the adapter's context.
 *
 * Returns: the three the codec needs — the serializer, the compression config
 * and the offloader — so a codec call names what it uses rather than taking the
 * whole context.
 *
 * Throws: nothing.
 */
export function codecDeps(context: CheckpointerContext): CodecDeps {
  return { serde: context.serde, compression: context.compression, offloader: context.offloader };
}

function withTtl<T extends { ttl?: number }>(item: T, ttlTimestamp?: number): T {
  if (ttlTimestamp !== undefined) item.ttl = ttlTimestamp;
  return item;
}

/**
 * Encode a checkpoint + metadata into its META and PAYLOAD items.
 *
 * Each offloaded payload is addressed by its own content hash under the row
 * that points at it, so a second put of the same checkpoint id — a retry after
 * a lost response, or a repair tool re-writing a checkpoint — writes the same
 * bytes to the same key instead of creating a second object.
 *
 * Accepts: `checkpoint` — every channel value it carries is stored; see
 * `putCheckpoint` for why nothing is narrowed away. `parentCheckpointId` — the
 * checkpoint this one continues, absent for a root. `ttlTimestamp` — stamped on
 * both rows so they expire together.
 *
 * Returns: the META row (light: ids, metadata, index keys) and the PAYLOAD row
 * (heavy: the checkpoint itself), which the caller writes in that order —
 * payload first, so a META row never names a payload that is not there yet.
 *
 * Throws: ValidationError naming `value` for a checkpoint the serializer cannot
 * represent; `S3_OFFLOAD_FAILED` when an offloaded payload cannot be uploaded.
 * Encoding precedes every write, so a checkpoint that cannot be stored never
 * half-writes a thread.
 */
export async function buildCheckpointItems(
  context: CheckpointerContext,
  threadId: string,
  checkpointNs: string,
  checkpoint: Checkpoint,
  metadata: CheckpointMetadata,
  parentCheckpointId?: string,
  ttlTimestamp?: number,
): Promise<{ meta: CheckpointMetaItem; payload: CheckpointPayloadItem }> {
  const deps = codecDeps(context);
  const pk = partitionKey(threadId);
  const checkpointDescriptor = await encodePayload(checkpoint, deps, {
    keyParts: [threadId, checkpointNs, checkpoint.id, 'checkpoint'],
    row: { pk, sk: payloadSortKey(checkpointNs, checkpoint.id) },
  });
  const metadataDescriptor = await encodePayload(metadata, deps, {
    keyParts: [threadId, checkpointNs, checkpoint.id, 'metadata'],
    row: { pk, sk: metaSortKey(checkpointNs, checkpoint.id) },
  });
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
 * apart from another's when `dropSupersededWrites` resolves first-write-wins.
 * It identifies a DynamoDB write rather than an S3 object — offloaded payloads
 * are addressed by content hash under their own row, so two calls writing the
 * same bytes for the same row share one object by design.
 *
 * Returns: one row per write, special channels first, each carrying its
 * `occurrence` so a channel emitted twice by one call keeps both values.
 *
 * Throws: ValidationError naming `channel` or `value`; `S3_OFFLOAD_FAILED`.
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
): Promise<CheckpointWriteItem[]> {
  /** Reject a bad channel before any payload is encoded or uploaded. */
  for (const [channel] of writes) validateChannel(channel);
  const deps = codecDeps(context);
  const pk = partitionKey(threadId);
  const items: CheckpointWriteItem[] = [];
  for (const { channel, value, index, occurrence } of resolveWriteIndices(writes)) {
    /**
     * `channel` is part of the key as well as the index: two channels can
     * share an index (each channel's first occurrence is 0), so without it
     * their uploads would collide on one S3 object within a single call.
     */
    const sk = writeSortKey(checkpointNs, checkpointId, taskId, index, channel);
    const descriptor = await encodePayload(value, deps, {
      keyParts: [threadId, checkpointNs, checkpointId, taskId, `write-${index}`, channel],
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
  return items;
}
