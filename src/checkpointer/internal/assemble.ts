import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointMetadata, CheckpointTuple } from '@langchain/langgraph-checkpoint';

import type { CheckpointMetaItem } from '../types';
import { fetchPayload, fetchPendingWrites } from './fetch';
import { readCheckpoint, readMetadata } from './item-reader';
import type { CheckpointerContext } from './setup';

/** How a tuple is assembled: cancellation, read consistency, and metadata already decoded by the caller. */
export interface AssembleOptions {
  signal?: AbortSignal;
  /** `true` for `getTuple` (read-your-writes), `false` for the eventually-consistent `list` path. */
  consistent: boolean;
  /** Metadata the caller decoded to apply a filter, so it is not decoded (or downloaded) twice. */
  metadata?: CheckpointMetadata;
}

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
  options: AssembleOptions,
): Promise<CheckpointTuple | undefined> {
  const read = { signal: options.signal, consistent: options.consistent };
  const payload = await fetchPayload(context, threadId, checkpointNs, meta.checkpointId, read);
  if (!payload) return undefined;
  const [checkpoint, metadata, pendingWrites] = await Promise.all([
    readCheckpoint(context, payload, threadId),
    options.metadata ?? readMetadata(context, meta, threadId),
    fetchPendingWrites(context, threadId, checkpointNs, meta.checkpointId, read),
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
