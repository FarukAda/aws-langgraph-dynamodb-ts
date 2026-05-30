import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointPendingWrite,
} from '@langchain/langgraph-checkpoint';

import { decodePayload } from '../../shared/codec/codec';
import type { CheckpointMetaItem, CheckpointPayloadItem, CheckpointWriteItem } from '../types';
import { codecDeps } from './item-writer';
import type { CheckpointerContext } from './setup';

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
