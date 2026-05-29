import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointTuple } from '@langchain/langgraph-checkpoint';

import { readConfigurable } from '../internal/configurable';
import { fetchPayload, fetchPendingWrites, fetchTargetMeta } from '../internal/fetch';
import { readCheckpoint, readMetadata } from '../internal/item-reader';
import type { CheckpointerContext } from '../internal/setup';

function configFor(threadId: string, checkpointNs: string, checkpointId: string): RunnableConfig {
  return {
    configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpointId },
  };
}

/**
 * Load a checkpoint tuple: the target checkpoint (by id, or the newest in the
 * namespace), its metadata, its pending writes, and a parent config when the
 * checkpoint has a parent. Returns undefined when no matching checkpoint exists.
 */
export async function getCheckpointTuple(
  context: CheckpointerContext,
  config: RunnableConfig,
): Promise<CheckpointTuple | undefined> {
  const { threadId, checkpointNs, checkpointId } = readConfigurable(config);
  const meta = await fetchTargetMeta(context, threadId, checkpointNs, checkpointId);
  if (!meta) return undefined;
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
