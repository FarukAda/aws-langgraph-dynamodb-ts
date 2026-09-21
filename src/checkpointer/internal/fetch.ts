import type { CheckpointPendingWrite } from '@langchain/langgraph-checkpoint';

import { nowSeconds } from '../../shared/clock';
import { LIST_SCAN_WARN_THRESHOLD } from '../../shared/constants';
import { isExpiredRow, withoutExpired } from '../../shared/dynamodb/expiry';
import { paginateQuery } from '../../shared/dynamodb/paginate';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { assertReadableRow } from '../../shared/dynamodb/row-version';
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

/**
 * Rows one page of the newest-first META read evaluates. The read stops at the
 * first live row of ours, so this decides only how many *dead* rows one round
 * trip can step over: at one row per page, a thread whose head has aged out
 * under a `ttl` cost one `Query` per expired row, and DynamoDB's own sweep may
 * lag that `ttl` by up to 48 hours, so the run of dead rows is as long as the
 * thread is busy. This is the hottest read the package performs — every graph
 * step begins with it — so paying a round trip per aged-out row was the wrong
 * side of the trade.
 *
 * The trade runs the other way when nothing at the head has expired, which is
 * every thread that sets no `ttl` at all. DynamoDB applies `Limit` before the
 * filter and bills for what it evaluated, so such a read now pays for up to
 * this many META rows and keeps exactly one. A META row measures roughly 500
 * bytes for a typical checkpoint, which puts a page at ~26 KB: about seven
 * strongly consistent read units where a single row costs one, and a fortieth
 * of the 1 MB a `Query` may return, so the page size rather than the response
 * cap is always what ends a page.
 */
const LATEST_META_PAGE_SIZE = 50;

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
 * DynamoDB's sweep lags. The newest-first read returns the first live row of
 * ours and stops there, stepping over expired and foreign rows
 * {@link LATEST_META_PAGE_SIZE} at a time rather than one per round trip.
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
      (request) =>
        context.client.get(
          {
            TableName: context.tableName,
            Key: { PK: partitionKey(threadId), SK: metaSortKey(checkpointNs, checkpointId) },
            ConsistentRead: true,
          },
          request,
        ),
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
      limit: LATEST_META_PAGE_SIZE,
      consistent: true,
    },
  );
  /**
   * Both caps stay off, each for its own reason. `maxItems` counts the rows
   * yielded past the server-side filter, and a finite value there would add
   * the probe {@link paginateQuery} runs to tell a reached cap apart from an
   * exhausted read — more requests, on the read the page size above exists to
   * make cheaper. `maxIterations` is the runaway guard, but a finite value
   * would turn a namespace whose rows have all aged out into a thrown
   * `ResultTruncatedError` where this function documents `undefined`, failing
   * every graph step on exactly the thread shape the page size is here to
   * serve. The page size is what bounds the walk instead: it divides the
   * requests a dead head costs by {@link LATEST_META_PAGE_SIZE}.
   */
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
 * Throws: `FORMAT_UNSUPPORTED` for a row a newer release wrote; whatever the
 * read throws.
 */
export async function fetchPayload(
  context: CheckpointerContext,
  threadId: string,
  checkpointNs: string,
  checkpointId: string,
  read: ReadOptions = {},
): Promise<CheckpointPayloadItem | undefined> {
  const result = await withDynamoDBRetry(
    (request) =>
      context.client.get(
        {
          TableName: context.tableName,
          Key: { PK: partitionKey(threadId), SK: payloadSortKey(checkpointNs, checkpointId) },
          ConsistentRead: read.consistent ?? true,
        },
        request,
      ),
    retryFor(context, read.signal),
  );
  const item = result.Item as CheckpointPayloadItem | undefined;
  /**
   * A payload of ours written by a newer release fails loudly, as its META row
   * would: decoding it under today's rules is how a checkpoint comes back with
   * state silently missing.
   */
  if (item !== undefined) assertReadableRow(item, 'checkpoint payload');
  return item;
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
 * Throws: `FORMAT_UNSUPPORTED` for a row a newer release wrote; whatever the
 * query or the payload decode throws.
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
    /**
     * Checked before `dropSupersededWrites` reads `writeGroup`: that dedup runs
     * on every row regardless of format, and a newer format may give the
     * attribute a different meaning.
     */
    assertReadableRow(item, 'pending write');
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
