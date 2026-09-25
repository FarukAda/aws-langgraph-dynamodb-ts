import type { RunnableConfig } from '@langchain/core/runnables';
import type {
  Checkpoint,
  CheckpointMetadata,
  PendingWrite,
  PutOperation,
  SearchOperation,
} from '@langchain/langgraph-checkpoint';

import {
  parsePutRequest,
  parsePutWritesRequest,
  parseThreadConfig,
  type ThreadAddress,
} from '../../../src/checkpointer/internal/parse';
import { buildCheckpointRows, buildWriteRows } from '../../../src/checkpointer/internal/rows';
import type { CheckpointerContext } from '../../../src/checkpointer/internal/setup';
import {
  parseNamespacePrefix,
  parseOperation,
  parseSearch,
  type ParsedDelete,
  type ParsedPut,
  type ParsedSearch,
} from '../../../src/store/internal/parse';

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
): ReturnType<typeof buildCheckpointRows> {
  const request = parsePutRequest(
    configFor(threadId, checkpointNs, parentCheckpointId, signal),
    checkpoint,
    metadata,
  );
  return buildCheckpointRows(context, request, ttlTimestamp);
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
): ReturnType<typeof buildWriteRows> {
  const request = parsePutWritesRequest(
    configFor(threadId, checkpointNs, checkpointId, signal),
    writes,
    taskId,
  );
  return buildWriteRows(context, request, writeGroup, ttlTimestamp);
}

/** A batch put (or, for a `null` value, delete) as the store dispatches it. */
export function parsedPut(op: PutOperation): ParsedPut | ParsedDelete {
  const parsed = parseOperation(op);
  if (parsed.kind !== 'put' && parsed.kind !== 'delete') {
    throw new Error(`expected a put or a delete, parsed a ${parsed.kind}`);
  }
  return parsed;
}

/** A search as the store runs it; `offset` and `limit` override the operation's own. */
export function parsedSearch(op: SearchOperation, offset?: number, limit?: number): ParsedSearch {
  return parseSearch(parseNamespacePrefix(op.namespacePrefix, 'namespacePrefix'), {
    ...op,
    offset: offset ?? op.offset,
    limit: limit ?? op.limit,
  });
}
