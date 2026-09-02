import type { CheckpointPendingWrite } from '@langchain/langgraph-checkpoint';

import { LIST_SCAN_WARN_THRESHOLD } from '../../shared/constants';
import { paginateQuery } from '../../shared/dynamodb/paginate';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import type { DocItem } from '../../shared/dynamodb/types';
import type { CheckpointMetaItem, CheckpointPayloadItem, CheckpointWriteItem } from '../types';
import { narrowHead, toPendingWrites } from './item-reader';
import {
  metaSortKey,
  metaSortKeyPrefix,
  partitionKey,
  payloadSortKey,
  writeSortKeyPrefix,
} from './keys';
import { beginsWithQuery } from './query';
import type { CheckpointerContext } from './setup';

/** Per-read options for the payload and writes reads. */
export interface ReadOptions {
  signal?: AbortSignal;
  /** `false` for bulk reads (`list`) that trade read-your-writes for half the read cost. */
  consistent?: boolean;
}

/**
 * Fetch the target META item: by id when given, else the newest in the
 * namespace. The newest-first read pages one row at a time past any foreign
 * row until it finds a real checkpoint.
 */
export async function fetchTargetMeta(
  context: CheckpointerContext,
  threadId: string,
  checkpointNs: string,
  checkpointId?: string,
  signal?: AbortSignal,
): Promise<CheckpointMetaItem | undefined> {
  if (checkpointId !== undefined) {
    const result = await withDynamoDBRetry(
      () =>
        context.client.get({
          TableName: context.tableName,
          Key: { PK: partitionKey(threadId), SK: metaSortKey(checkpointNs, checkpointId) },
          ConsistentRead: true,
        }),
      retryFor(context, signal),
    );
    return narrowHead(context, result.Item as DocItem | undefined);
  }
  const params = beginsWithQuery(
    context.tableName,
    partitionKey(threadId),
    metaSortKeyPrefix(checkpointNs),
    {
      limit: 1,
      consistent: true,
    },
  );
  const rows = paginateQuery({
    retry: retryFor(context, signal),
    signal,
    client: context.client,
    params,
    maxItems: Number.POSITIVE_INFINITY,
    maxIterations: Number.POSITIVE_INFINITY,
  });
  for await (const raw of rows) {
    const meta = narrowHead(context, raw);
    if (meta) return meta;
  }
  return undefined;
}

/** Fetch the PAYLOAD item for a checkpoint. */
export async function fetchPayload(
  context: CheckpointerContext,
  threadId: string,
  checkpointNs: string,
  checkpointId: string,
  read: ReadOptions = {},
): Promise<CheckpointPayloadItem | undefined> {
  const result = await withDynamoDBRetry(
    () =>
      context.client.get({
        TableName: context.tableName,
        Key: { PK: partitionKey(threadId), SK: payloadSortKey(checkpointNs, checkpointId) },
        ConsistentRead: read.consistent ?? true,
      }),
    retryFor(context, read.signal),
  );
  return result.Item as CheckpointPayloadItem | undefined;
}

/** Fetch and decode every pending write for a checkpoint, in write order. */
export async function fetchPendingWrites(
  context: CheckpointerContext,
  threadId: string,
  checkpointNs: string,
  checkpointId: string,
  read: ReadOptions = {},
): Promise<CheckpointPendingWrite[]> {
  const params = beginsWithQuery(
    context.tableName,
    partitionKey(threadId),
    writeSortKeyPrefix(checkpointNs, checkpointId),
    { ascending: true, consistent: read.consistent ?? true },
  );
  /**
   * Unbounded: the read must be complete to be correct, and a Send fan-out
   * retried with a changed write order leaves superseded rows behind that
   * count toward any cap. Past the warning threshold the read still succeeds,
   * but an operator is told the checkpoint is unusually heavy.
   */
  const items: CheckpointWriteItem[] = [];
  for await (const item of paginateQuery({
    retry: retryFor(context, read.signal),
    signal: read.signal,
    client: context.client,
    params,
    maxItems: Number.POSITIVE_INFINITY,
    maxIterations: Number.POSITIVE_INFINITY,
  })) {
    items.push(item as CheckpointWriteItem);
  }
  if (items.length >= LIST_SCAN_WARN_THRESHOLD) {
    context.logger.warn(
      'getTuple: a checkpoint carries very many pending-write rows; the read is complete but slow',
      {
        threadId,
        checkpointId,
        rows: items.length,
      },
    );
  }
  return toPendingWrites(context, items, threadId);
}
