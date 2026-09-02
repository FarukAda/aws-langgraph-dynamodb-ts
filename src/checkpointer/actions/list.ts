import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointListOptions, CheckpointTuple } from '@langchain/langgraph-checkpoint';

import { nowSeconds } from '../../shared/clock';
import { LIST_SCAN_WARN_THRESHOLD } from '../../shared/constants';
import { isExpiredRow, withoutExpired } from '../../shared/dynamodb/expiry';
import { paginateQuery } from '../../shared/dynamodb/paginate';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { paginateScan } from '../../shared/dynamodb/scan';
import type { DocItem } from '../../shared/dynamodb/types';
import { assembleTuple } from '../internal/assemble';
import { fetchTargetMeta } from '../internal/fetch';
import { narrowMetaItem } from '../internal/item-reader';
import {
  type ListScope,
  listQuery,
  listScan,
  passesKeyFilters,
  passesMetadataFilter,
  readListScope,
} from '../internal/list-scope';
import type { CheckpointerContext } from '../internal/setup';
import type { CheckpointMetaItem } from '../types';

/**
 * The tuple for one META item that passes every filter, assembled eventually
 * consistently (a history listing tolerates a replica lag `getTuple` does not)
 * and reusing the metadata the filter already decoded. Undefined when the row
 * is filtered out or its payload is missing.
 */
async function tupleFor(
  context: CheckpointerContext,
  meta: CheckpointMetaItem,
  scope: ListScope,
): Promise<CheckpointTuple | undefined> {
  if (!passesKeyFilters(meta, scope)) return undefined;
  const verdict = await passesMetadataFilter(context, meta, scope);
  if (!verdict.pass) return undefined;
  return assembleTuple(context, meta.threadId, meta.checkpointNs, meta, {
    signal: scope.signal,
    consistent: false,
    metadata: verdict.metadata,
  });
}

/** A `checkpoint_id` addresses one row: read it directly instead of scanning the namespace for it. */
async function* listOne(
  context: CheckpointerContext,
  scope: ListScope & { threadId: string },
): AsyncGenerator<CheckpointTuple> {
  const meta = await fetchTargetMeta(
    context,
    scope.threadId,
    scope.checkpointNs ?? '',
    scope.checkpointId,
    scope.signal,
  );
  if (!meta) return;
  const tuple = await tupleFor(context, meta, scope);
  if (tuple) yield tuple;
}

/** Narrow a scanned row, warning about (and skipping) one that is not a checkpoint meta item. */
function narrowOrWarn(context: CheckpointerContext, raw: DocItem): CheckpointMetaItem | undefined {
  const meta = narrowMetaItem(raw);
  if (!meta) {
    context.logger.warn('list: skipped a row that is not a checkpoint meta item', {
      sortKey: raw.SK as string,
    });
  }
  return meta;
}

/** The META rows a scope covers: a partition query for a thread, a table scan without one. */
function metaRows(
  context: CheckpointerContext,
  scope: ListScope,
  now: number,
): AsyncGenerator<DocItem> {
  const retry = retryFor(context, scope.signal);
  const bounds = { maxItems: Number.POSITIVE_INFINITY, maxIterations: Number.POSITIVE_INFINITY };
  return scope.threadId === undefined
    ? paginateScan({
        retry,
        signal: scope.signal,
        client: context.client,
        params: withoutExpired(listScan(context, scope), now),
        ...bounds,
      })
    : paginateQuery({
        retry,
        signal: scope.signal,
        client: context.client,
        params: withoutExpired(listQuery(context, { ...scope, threadId: scope.threadId }), now),
        ...bounds,
      });
}

/**
 * Yield checkpoint tuples for a thread, newest first: every namespace when the
 * config names none (grouped by namespace, newest first within each), else the
 * one namespace given. Without a `thread_id` every thread in the table is
 * listed through a table scan, as the reference savers do; that read is
 * unordered across threads and cross-tenant by construction. Honors
 * `options.before` (only checkpoints older than the given id),
 * `options.filter` (metadata equality), and `options.limit` (max tuples
 * yielded; the read stops right after the yield that reaches it).
 *
 * The scan is deliberately unbounded: this generator streams and never
 * accumulates, `limit` returns early, and a raw-row cap would turn a caller
 * asking for a handful of rare matches over a large thread into a hard error
 * instead of the true (possibly empty) answer. Past the warning threshold an
 * operator is told to narrow the filter or pass a limit.
 */
export async function* listCheckpoints(
  context: CheckpointerContext,
  config: RunnableConfig,
  options?: CheckpointListOptions,
): AsyncGenerator<CheckpointTuple> {
  const scope = readListScope(config, options);
  if (scope.threadId !== undefined && scope.checkpointId !== undefined) {
    yield* listOne(context, { ...scope, threadId: scope.threadId });
    return;
  }
  const now = nowSeconds();
  let yielded = 0;
  let scanned = 0;
  for await (const raw of metaRows(context, scope, now)) {
    scanned += 1;
    if (scanned === LIST_SCAN_WARN_THRESHOLD) {
      context.logger.warn(
        'list: scanned a large number of rows without the caller stopping; this read is ' +
          'deliberately unbounded, so narrow the filter or pass options.limit',
        { threadId: scope.threadId, checkpointNs: scope.checkpointNs, scanned },
      );
    }
    const meta = narrowOrWarn(context, raw);
    if (!meta || isExpiredRow(meta, now)) continue;
    const tuple = await tupleFor(context, meta, scope);
    if (!tuple) continue;
    yield tuple;
    yielded += 1;
    if (scope.limit !== undefined && yielded >= scope.limit) return;
  }
}
