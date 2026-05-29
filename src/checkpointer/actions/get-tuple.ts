import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointTuple } from '@langchain/langgraph-checkpoint';

import { assembleTuple } from '../internal/assemble';
import { readConfigurable } from '../internal/configurable';
import { fetchTargetMeta } from '../internal/fetch';
import type { CheckpointerContext } from '../internal/setup';

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
  return assembleTuple(context, threadId, checkpointNs, meta);
}
