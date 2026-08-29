import type {
  Checkpoint,
  CheckpointMetadata,
  PendingWrite,
  PendingWriteValue,
} from '@langchain/langgraph-checkpoint';
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

/** One write with its sort-key index resolved exactly once. */
export interface ResolvedWrite {
  channel: string;
  value: PendingWriteValue;
  index: number;
}

/**
 * Assign every write in one `putWrites` call its sort-key index, in a single
 * pass — the index is never recomputed downstream, which is what used to let
 * the deduped array's positions disagree with the ones the caller's array
 * produced.
 *
 * A special channel takes its fixed `WRITES_IDX_MAP` slot, and a later
 * duplicate replaces an earlier one (last-write-wins, matching the reference
 * checkpointer). A regular channel takes the number of times it has already
 * appeared in *this call*, so a retried task re-emitting the same channel
 * lands on the same row — a true duplicate the first-write-wins guard
 * correctly rejects — while a channel the retry newly emitted gets a row of
 * its own instead of silently displacing an unrelated write. Values written
 * repeatedly to one channel keep their relative order, which is the only
 * ordering LangGraph's `_applyWrites` depends on.
 *
 * `Object.hasOwn` guards WRITES_IDX_MAP's own `Object.prototype` chain — a
 * channel literally named `constructor`/`toString`/etc. must be treated as
 * regular, not resolve to an inherited function reference.
 */
export function resolveWriteIndices(writes: PendingWrite[]): ResolvedWrite[] {
  const bySpecialIndex = new Map<number, ResolvedWrite>();
  const regular: ResolvedWrite[] = [];
  const occurrences = new Map<string, number>();
  for (const [channel, value] of writes) {
    if (Object.hasOwn(WRITES_IDX_MAP, channel)) {
      const index = WRITES_IDX_MAP[channel];
      bySpecialIndex.set(index, { channel, value, index });
      continue;
    }
    const occurrence = occurrences.get(channel) ?? 0;
    occurrences.set(channel, occurrence + 1);
    regular.push({ channel, value, index: occurrence });
  }
  return [...bySpecialIndex.values(), ...regular];
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
  const deps = codecDeps(context);
  const pk = partitionKey(threadId);
  const items: CheckpointWriteItem[] = [];
  for (const { channel, value, index } of resolveWriteIndices(writes)) {
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
      value: descriptor,
    };
    items.push(withTtl(item, ttlTimestamp));
  }
  return items;
}
