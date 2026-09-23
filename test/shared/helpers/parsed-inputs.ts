import type { RunnableConfig } from '@langchain/core/runnables';
import type { Checkpoint, CheckpointMetadata, PendingWrite } from '@langchain/langgraph-checkpoint';

import {
  buildCheckpointItems,
  buildWriteItems,
} from '../../../src/checkpointer/internal/item-writer';
import {
  parsePutRequest,
  parsePutWritesRequest,
  parseThreadConfig,
  type ThreadAddress,
} from '../../../src/checkpointer/internal/parse';
import type { CheckpointerContext } from '../../../src/checkpointer/internal/setup';

/**
 * Builders for the parsed inputs internal functions take. Every one goes
 * through the real parser — a test never casts a string to a brand — so a
 * fixture a parser would refuse fails where it is written.
 */
function configFor(
  threadId: string,
  checkpointNs: string,
  checkpointId?: string,
  signal?: AbortSignal,
): RunnableConfig {
  return {
    configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpointId },
    signal,
  };
}

/** The address of a thread, a namespace and optionally one checkpoint. */
export function threadAddress(
  threadId: string,
  checkpointNs: string,
  checkpointId?: string,
): ThreadAddress {
  return parseThreadConfig(configFor(threadId, checkpointNs, checkpointId)).address;
}

/** The META and PAYLOAD rows a put of `checkpoint` would write. */
export async function checkpointItems(
  context: CheckpointerContext,
  threadId: string,
  checkpointNs: string,
  checkpoint: Checkpoint,
  metadata: CheckpointMetadata,
  parentCheckpointId?: string,
  ttlTimestamp?: number,
  signal?: AbortSignal,
): ReturnType<typeof buildCheckpointItems> {
  const request = parsePutRequest(
    configFor(threadId, checkpointNs, parentCheckpointId, signal),
    checkpoint,
    metadata,
  );
  return buildCheckpointItems(context, request, ttlTimestamp);
}

/** The WRITE rows a putWrites of `writes` would write. */
export async function writeItems(
  context: CheckpointerContext,
  threadId: string,
  checkpointNs: string,
  checkpointId: string,
  taskId: string,
  writes: PendingWrite[],
  writeGroup: string,
  ttlTimestamp?: number,
  signal?: AbortSignal,
): ReturnType<typeof buildWriteItems> {
  const request = parsePutWritesRequest(
    configFor(threadId, checkpointNs, checkpointId, signal),
    writes,
    taskId,
  );
  return buildWriteItems(context, request, writeGroup, ttlTimestamp);
}
