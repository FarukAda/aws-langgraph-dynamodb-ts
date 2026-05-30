import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointTuple } from '@langchain/langgraph-checkpoint';

import type { CheckpointMetaItem } from '../types';
import { fetchPayload, fetchPendingWrites } from './fetch';
import { readCheckpoint, readMetadata } from './item-reader';
import type { CheckpointerContext } from './setup';

/** Build a config that addresses a specific checkpoint. */
function configFor(threadId: string, checkpointNs: string, checkpointId: string): RunnableConfig {
  return {
    configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpointId },
  };
}

/**
 * Assemble a full {@link CheckpointTuple} from a META item: fetch and decode its
 * payload, metadata, and pending writes, attaching a parent config when present.
 * Returns undefined when the payload item is missing (inconsistent state).
 */
export async function assembleTuple(
  context: CheckpointerContext,
  threadId: string,
  checkpointNs: string,
  meta: CheckpointMetaItem,
): Promise<CheckpointTuple | undefined> {
  const payload = await fetchPayload(context, threadId, checkpointNs, meta.checkpointId);
  if (!payload) return undefined;
  const [checkpoint, metadata, pendingWrites] = await Promise.all([
    readCheckpoint(context, payload),
    readMetadata(context, meta),
    fetchPendingWrites(context, threadId, checkpointNs, meta.checkpointId),
  ]);
  const tuple: CheckpointTuple = {
    config: configFor(threadId, checkpointNs, meta.checkpointId),
    checkpoint,
    metadata,
    pendingWrites,
  };
  if (meta.parentCheckpointId !== undefined) {
    tuple.parentConfig = configFor(threadId, checkpointNs, meta.parentCheckpointId);
  }
  return tuple;
}
