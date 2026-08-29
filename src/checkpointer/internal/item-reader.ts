import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointPendingWrite,
} from '@langchain/langgraph-checkpoint';

import { decodePayload } from '../../shared/codec/codec';
import type { DocItem } from '../../shared/dynamodb/types';
import type { CheckpointMetaItem, CheckpointPayloadItem, CheckpointWriteItem } from '../types';
import { codecDeps } from './item-writer';
import type { CheckpointerContext } from './setup';

/**
 * Narrow a raw row to a {@link CheckpointMetaItem}, or `undefined` for a row
 * that merely shares the `META#` sort-key prefix. Replaces an unchecked cast
 * at the one boundary where a row may not have been written by this adapter.
 */
export function narrowMetaItem(raw: DocItem): CheckpointMetaItem | undefined {
  return typeof raw.checkpointId === 'string' &&
    typeof raw.checkpointNs === 'string' &&
    raw.metadata !== undefined
    ? (raw as CheckpointMetaItem)
    : undefined;
}

/** Decode the checkpoint stored in a PAYLOAD item. */
export async function readCheckpoint(
  context: CheckpointerContext,
  item: CheckpointPayloadItem,
): Promise<Checkpoint> {
  return decodePayload<Checkpoint>(item.checkpoint, codecDeps(context));
}

/** Decode the metadata stored in a META item. */
export async function readMetadata(
  context: CheckpointerContext,
  item: CheckpointMetaItem,
): Promise<CheckpointMetadata> {
  return decodePayload<CheckpointMetadata>(item.metadata, codecDeps(context));
}

/** Decode WRITE items into `[taskId, channel, value]` pending-write tuples. */
export async function toPendingWrites(
  context: CheckpointerContext,
  items: CheckpointWriteItem[],
): Promise<CheckpointPendingWrite[]> {
  const deps = codecDeps(context);
  const pending: CheckpointPendingWrite[] = [];
  for (const item of items) {
    const value = await decodePayload(item.value, deps);
    pending.push([item.taskId, item.channel, value]);
  }
  return pending;
}
