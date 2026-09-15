import type { CheckpointPendingWrite } from '@langchain/langgraph-checkpoint';

import { nowSeconds } from '../../shared/clock';
import { LIST_SCAN_WARN_THRESHOLD } from '../../shared/constants';
import { isExpiredRow, withoutExpired } from '../../shared/dynamodb/expiry';
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
 * The META row a read is about: the one `checkpointId` names, else the newest
 * in the namespace.
 *
 * Accepts: `checkpointId` — its absence asks for the newest. `signal` — aborts
 * the read.
 *
 * Returns: the row, or undefined when there is none — including when every row
 * in the namespace has expired, or when the only rows there belong to another
 * writer.
 *
 * Throws: `FORMAT_UNSUPPORTED` for a row of ours written by a newer version;
 * whatever the read throws.
 *
 * Guarantees: strongly consistent, and expiry is judged here rather than waited
 * for, so a checkpoint past its ttl is absent to every reader however long
 * DynamoDB's sweep lags. The newest-first read pages one row at a time past any
 * foreign row until it finds a real checkpoint.
 */
export async function fetchTargetMeta(
  context: CheckpointerContext,
  threadId: string,
  checkpointNs: string,
  checkpointId?: string,
  signal?: AbortSignal,
): Promise<CheckpointMetaItem | undefined> {
  /** Expired rows are absent to every reader, however long DynamoDB's sweep lags. */
  const now = nowSeconds();
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
    const meta = narrowHead(context, result.Item as DocItem | undefined);
    return meta && !isExpiredRow(meta, now) ? meta : undefined;
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
    params: withoutExpired(params, now),
    maxItems: Number.POSITIVE_INFINITY,
    maxIterations: Number.POSITIVE_INFINITY,
  });
  for await (const raw of rows) {
    const meta = narrowHead(context, raw);
    if (meta && !isExpiredRow(meta, now)) return meta;
  }
  return undefined;
}

/**
 * The PAYLOAD row of one checkpoint.
 *
 * Accepts: `read.consistent` — defaults to true; `list` passes false and
 * accepts replica lag, since a listing tolerates what a read-your-writes
 * `getTuple` does not.
 *
 * Returns: the row, or undefined when it is not there — the window the ordered
 * PAYLOAD→META write leaves open, which the caller answers as "no checkpoint".
 *
 * Throws: whatever the read throws.
 */
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

/**
 * Every pending write stored for one checkpoint, decoded, in write order.
 *
 * Accepts: `read.consistent` — omitted reads strongly consistently; `list`
 * passes `false` explicitly and accepts replica lag, `getTuple` passes `true`.
 *
 * Returns: the writes after `dropSupersededWrites` has resolved
 * first-write-wins; a checkpoint with none returns an empty array.
 *
 * Throws: whatever the query or the payload decode throws.
 *
 * Guarantees: the read is deliberately uncapped. It must be complete to be
 * correct — a `Send` fan-out retried with a changed write order leaves
 * superseded rows behind that would count toward any cap — so past
 * {@link LIST_SCAN_WARN_THRESHOLD} rows the read still succeeds and an operator
 * is told the checkpoint is unusually heavy.
 */
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
