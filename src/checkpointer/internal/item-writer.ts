import type { Checkpoint, CheckpointMetadata, PendingWrite } from '@langchain/langgraph-checkpoint';
import { WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint';

import { type CodecDeps, encodePayload } from '../../shared/codec/codec';
import type { CheckpointMetaItem, CheckpointPayloadItem, CheckpointWriteItem } from '../types';
import { metaSortKey, partitionKey, payloadSortKey, writeSortKey } from './keys';
import type { CheckpointerContext } from './setup';

/** Map a context to the codec collaborators. */
export function codecDeps(context: CheckpointerContext): CodecDeps {
  return { serde: context.serde, compression: context.compression, offloader: context.offloader };
}

function withTtl<T extends { ttl?: number }>(item: T, ttlTimestamp?: number): T {
  if (ttlTimestamp !== undefined) item.ttl = ttlTimestamp;
  return item;
}

/** Encode a checkpoint + metadata into its META and PAYLOAD items. */
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
  });
  const metadataDescriptor = await encodePayload(metadata, deps, {
    keyParts: [threadId, checkpointNs, checkpoint.id, 'metadata'],
  });
  const meta: CheckpointMetaItem = {
    PK: pk,
    SK: metaSortKey(checkpointNs, checkpoint.id),
    threadId,
    checkpointNs,
    checkpointId: checkpoint.id,
    metadata: metadataDescriptor,
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
 * unique per `putWrites` *call* (not per write) and is appended to the S3
 * offload keyParts of **regular (non-negative-index) writes only** — the ones
 * written conditionally, first-write-wins. There, repeated/concurrent attempts
 * for the same (thread, checkpoint, task, index) must never share an S3
 * location, so a failed attempt's cleanup can only ever delete its own upload.
 * Special (negative-index) writes are overwritten in place, so their key stays
 * deterministic: nonce'ing it would strand the previous upload — referenced by
 * nothing, tracked by nothing, cleaned up by nothing — on every rewrite of the
 * same special channel.
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
  const deps = codecDeps(context);
  const pk = partitionKey(threadId);
  const items: CheckpointWriteItem[] = [];
  for (let positional = 0; positional < writes.length; positional++) {
    const [channel, value] = writes[positional];
    const index = WRITES_IDX_MAP[channel] ?? positional;
    const baseKeyParts = [threadId, checkpointNs, checkpointId, taskId, `write-${index}`];
    const descriptor = await encodePayload(value, deps, {
      keyParts: index < 0 ? baseKeyParts : [...baseKeyParts, nonce],
    });
    const item: CheckpointWriteItem = {
      PK: pk,
      SK: writeSortKey(checkpointNs, checkpointId, taskId, index),
      taskId,
      index,
      channel,
      value: descriptor,
    };
    items.push(withTtl(item, ttlTimestamp));
  }
  return items;
}
