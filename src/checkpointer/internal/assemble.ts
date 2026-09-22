import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointMetadata, CheckpointTuple } from '@langchain/langgraph-checkpoint';

import type { CheckpointMetaItem } from '../types';
import { fetchPayload, fetchPendingWrites } from './fetch';
import { readCheckpoint, readMetadata } from './item-reader';
import { migratePendingSends } from './pending-sends';
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
 * A full {@link CheckpointTuple} built from a META row.
 *
 * Accepts: `threadId` — the **caller's**, never the row's: it scopes which S3
 * object the row may point at, so it must come from the partition the caller
 * asked for. `options.metadata` — already decoded by a filtered `list`, so a
 * filtered listing decodes and downloads each metadata blob once, not twice.
 * `options.consistent` — true for `getTuple`, false for `list`.
 *
 * Returns: the tuple, with `parentConfig` set only when the row names a parent;
 * `undefined` when the PAYLOAD row is absent — the window the ordered
 * PAYLOAD→META write leaves open, and the same answer a caller gets for a
 * checkpoint that does not exist.
 *
 * Throws: whatever the reads and decodes throw.
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
    readCheckpoint(context, payload, threadId, options.signal).then((stored) =>
      migratePendingSends(context, stored, threadId, checkpointNs, meta.parentCheckpointId, read),
    ),
    options.metadata ?? readMetadata(context, meta, threadId, options.signal),
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
