import type { Checkpoint, CheckpointMetadata, PendingWrite } from '@langchain/langgraph-checkpoint';

import { type CodecDeps } from '../../shared/codec/codec';
import { encodePayload } from '../../shared/codec/encode';
import type { CheckpointMetaItem, CheckpointPayloadItem, CheckpointWriteItem } from '../types';
import { metaSortKey, partitionKey, payloadSortKey, writeSortKey } from './keys';
import type { CheckpointerContext } from './setup';
import { withStoredChannels } from './stored-channels';
import { validateChannel } from './validation';
import { resolveWriteIndices } from './write-index';

/** Map a context to the codec collaborators. */
export function codecDeps(context: CheckpointerContext): CodecDeps {
  return { serde: context.serde, compression: context.compression, offloader: context.offloader };
}

function withTtl<T extends { ttl?: number }>(item: T, ttlTimestamp?: number): T {
  if (ttlTimestamp !== undefined) item.ttl = ttlTimestamp;
  return item;
}

/**
 * Encode a checkpoint + metadata into its META and PAYLOAD items. `nonce` is
 * unique per `put()` call and is appended to both S3 key part lists, so a
 * second put of the same checkpoint id — a retry after a lost response, or a
 * repair tool re-writing a checkpoint — never shares an object with the first.
 * That is what makes "the row holds my key" equivalent to "my write is live"
 * for the post-failure verification in `put.ts`, and what keeps a failed
 * re-put's cleanup from deleting the object the first, successful put's rows
 * point at. `storedChannels` narrows the stored `channel_values` (see
 * `selectStoredChannels`); by default every value is stored.
 */
export async function buildCheckpointItems(
  context: CheckpointerContext,
  threadId: string,
  checkpointNs: string,
  checkpoint: Checkpoint,
  metadata: CheckpointMetadata,
  nonce: string,
  parentCheckpointId?: string,
  ttlTimestamp?: number,
  storedChannels: readonly string[] = Object.keys(checkpoint.channel_values),
): Promise<{ meta: CheckpointMetaItem; payload: CheckpointPayloadItem }> {
  const deps = codecDeps(context);
  const pk = partitionKey(threadId);
  const checkpointDescriptor = await encodePayload(
    withStoredChannels(checkpoint, storedChannels),
    deps,
    {
      keyParts: [threadId, checkpointNs, checkpoint.id, 'checkpoint', nonce],
    },
  );
  const metadataDescriptor = await encodePayload(metadata, deps, {
    keyParts: [threadId, checkpointNs, checkpoint.id, 'metadata', nonce],
  });
  const meta: CheckpointMetaItem = {
    PK: pk,
    SK: metaSortKey(checkpointNs, checkpoint.id),
    threadId,
    checkpointNs,
    checkpointId: checkpoint.id,
    metadata: metadataDescriptor,
    storedChannels: [...storedChannels],
  };
  if (parentCheckpointId !== undefined) meta.parentCheckpointId = parentCheckpointId;
  const payload: CheckpointPayloadItem = {
    PK: pk,
    SK: payloadSortKey(checkpointNs, checkpoint.id),
    checkpoint: checkpointDescriptor,
  };
  return { meta: withTtl(meta, ttlTimestamp), payload: withTtl(payload, ttlTimestamp) };
}

/**
 * Encode a task's pending writes into one item per write. `nonce` must be
 * unique per `putWrites` *call* (not per write) and is appended to every
 * write's S3 offload keyParts — regular and special alike — so a repeated
 * write (a retried task re-emitting the same channel, or two calls to the
 * same special channel) never shares an S3 location with any earlier
 * attempt. Special (negative-index) writes still overwrite their DynamoDB
 * row in place (see {@link writeSpecialItemsWithCleanup}), but that
 * overwrite-safety now comes from reading the previous descriptor before
 * writing and only cleaning it up after the new row is confirmed committed —
 * the same pattern store/actions/put.ts uses for the identical "overwrite in
 * place, nonce every upload" shape.
 */
export async function buildWriteItems(
  context: CheckpointerContext,
  threadId: string,
  checkpointNs: string,
  checkpointId: string,
  taskId: string,
  writes: PendingWrite[],
  nonce: string,
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
    const descriptor = await encodePayload(value, deps, {
      keyParts: [threadId, checkpointNs, checkpointId, taskId, `write-${index}`, channel, nonce],
    });
    const item: CheckpointWriteItem = {
      PK: pk,
      SK: writeSortKey(checkpointNs, checkpointId, taskId, index, channel),
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
      writeGroup: nonce,
      occurrence,
      value: descriptor,
    };
    items.push(withTtl(item, ttlTimestamp));
  }
  return items;
}
