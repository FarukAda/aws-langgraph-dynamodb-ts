import { DEFAULT_READ_CONCURRENCY } from '../../shared/constants';
import type { DocItem } from '../../shared/dynamodb/client';
import { DEFAULT_INDEX_SHARDS } from '../../shared/dynamodb/index-keys';
import { iterateRecencyIndex } from '../../shared/dynamodb/index-query';
import { paginateQuery } from '../../shared/dynamodb/paginate';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { paginateScan } from '../../shared/dynamodb/scan';
import { withoutExpired } from '../../shared/dynamodb/table-schema';
import { truncateForLog } from '../../shared/logging/truncate';
import type { CheckpointMetaItem } from '../types';
import { narrowMetaItem } from './item-reader';
import { listQuery, listScan } from './list-scope';
import type { ListScope } from './parse';
import type { CheckpointerContext } from './setup';

/**
 * Every checkpoint META row of the table, newest first, without a thread to
 * scope the read.
 *
 * From the recency index when `indexName` is set, 100 rows a page: each shard
 * is read one DynamoDB page at a time, and its next page whenever it has no row
 * buffered and the page still needs one, with at most `readConcurrency` shards
 * queried at once, so memory is the page being built plus at most one DynamoDB
 * page per shard. Without `indexName` it is a table `Scan`: read capacity for
 * every row evaluated, not every row returned. The index path needs
 * `backfillRecencyIndex` to have run, or rows written before the index are not
 * in it.
 */
function threadlessRows(
  context: CheckpointerContext,
  scope: ListScope,
  now: number,
): AsyncGenerator<DocItem> {
  if (context.indexName === undefined) {
    return paginateScan({
      retry: retryFor(context, scope.signal),
      signal: scope.signal,
      client: context.client,
      params: withoutExpired(listScan(context, scope), now),
      maxItems: Number.POSITIVE_INFINITY,
      maxIterations: Number.POSITIVE_INFINITY,
    });
  }
  return iterateRecencyIndex({
    client: context.client,
    tableName: context.tableName,
    indexName: context.indexName,
    tag: 'CHKPT',
    shards: context.indexShards ?? DEFAULT_INDEX_SHARDS,
    concurrency: context.readConcurrency ?? DEFAULT_READ_CONCURRENCY,
    retry: retryFor(context, scope.signal),
    signal: scope.signal,
  });
}

/**
 * The META rows a scope covers: a partition query when the scope names a
 * thread, and {@link threadlessRows} when it does not.
 *
 * Accepts: `scope` — a thread, or none, in which case every thread in the table
 * is read, through the recency index when `indexName` is set and a scan
 * otherwise. `now` — the instant expiry is judged against, taken once so one
 * listing cannot disagree with itself.
 *
 * Returns: an async generator over the raw rows, newest-first within a
 * namespace. Abandoning it stops the read.
 *
 * Throws: whatever the query or scan throws; `ABORTED` when the signal
 * fires.
 *
 * Guarantees: the read is deliberately unbounded. This is a stream that never
 * accumulates, a limit stops it early, and a row cap would turn a caller asking
 * for a handful of rare matches over a large thread into a hard error instead
 * of the true answer.
 */
export function metaRows(
  context: CheckpointerContext,
  scope: ListScope,
  now: number,
): AsyncGenerator<DocItem> {
  const retry = retryFor(context, scope.signal);
  const bounds = { maxItems: Number.POSITIVE_INFINITY, maxIterations: Number.POSITIVE_INFINITY };
  return scope.threadId === undefined
    ? threadlessRows(context, scope, now)
    : paginateQuery({
        retry,
        signal: scope.signal,
        client: context.client,
        params: withoutExpired(listQuery(context, { ...scope, threadId: scope.threadId }), now),
        ...bounds,
      });
}

/**
 * Narrow a row from that stream, saying so when it is not one of ours.
 *
 * Accepts: `raw` — any row the stream yielded.
 *
 * Returns: the META item, or undefined for a row that is not this adapter's —
 * logged at `warn`, since on a shared table a row of another adapter can share
 * the sort-key prefix and an operator should know it is there.
 *
 * Throws: `FORMAT_UNSUPPORTED` for one of ours written by a newer version.
 *
 * Guarantees: a foreign row is skipped, never assembled. Treating one as a
 * checkpoint would surface a tuple built from another adapter's data.
 */
export function narrowOrWarn(
  context: CheckpointerContext,
  raw: DocItem,
): CheckpointMetaItem | undefined {
  const meta = narrowMetaItem(raw);
  if (!meta) {
    context.logger.warn('list: skipped a row that is not a checkpoint meta item', {
      sortKey: truncateForLog(raw.SK as string),
    });
  }
  return meta;
}
