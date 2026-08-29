import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointListOptions, CheckpointTuple } from '@langchain/langgraph-checkpoint';

import { paginateQuery } from '../../shared/dynamodb/paginate';
import { assembleTuple } from '../internal/assemble';
import { readConfigurable } from '../internal/configurable';
import { type FilterValue, matchesFilter } from '../internal/filter-match';
import { narrowMetaItem, readMetadata } from '../internal/item-reader';
import { metaSortKeyPrefix, partitionKey } from '../internal/keys';
import { beginsWithQuery } from '../internal/query';
import type { CheckpointerContext } from '../internal/setup';
import type { CheckpointMetaItem } from '../types';

/** Read list options into a flat, typed shape. */
function readListOptions(options?: CheckpointListOptions): {
  before: string | undefined;
  filter: Record<string, FilterValue> | undefined;
  limit: number | undefined;
} {
  return {
    before: options?.before?.configurable?.checkpoint_id as string | undefined,
    filter: options?.filter as Record<string, FilterValue> | undefined,
    limit: options?.limit,
  };
}

/**
 * True when `meta` passes the key-level list filters: `before` (strictly older
 * checkpoints) and an explicitly requested `checkpoint_id`. Split out from the
 * loop so each filter stays independently readable.
 */
function passesKeyFilters(
  meta: CheckpointMetaItem,
  checkpointId: string | undefined,
  before: string | undefined,
): boolean {
  if (checkpointId !== undefined && meta.checkpointId !== checkpointId) return false;
  return before === undefined || meta.checkpointId < before;
}

/** True when `meta` passes the (optional) metadata-equality filter. */
async function passesMetadataFilter(
  context: CheckpointerContext,
  meta: CheckpointMetaItem,
  filter: Record<string, FilterValue> | undefined,
): Promise<boolean> {
  if (!filter) return true;
  const metadata = (await readMetadata(context, meta)) as Record<string, FilterValue>;
  return matchesFilter(metadata, filter);
}

/**
 * Yield checkpoint tuples for a thread/namespace, newest first. Honors
 * `options.before` (only checkpoints older than the given id), `options.filter`
 * (metadata equality), and `options.limit` (max tuples yielded).
 */
export async function* listCheckpoints(
  context: CheckpointerContext,
  config: RunnableConfig,
  options?: CheckpointListOptions,
): AsyncGenerator<CheckpointTuple> {
  const { threadId, checkpointNs, checkpointId } = readConfigurable(config);
  const { before, filter, limit } = readListOptions(options);
  const params = beginsWithQuery(
    context.tableName,
    partitionKey(threadId),
    metaSortKeyPrefix(checkpointNs),
  );
  let yielded = 0;
  /**
   * Unbounded: this is a generator that streams and never accumulates, and
   * `limit` already returns early, so the caller's own bound is what stops the
   * read. The shared in-memory cap counts *raw rows pulled*, not
   * filter-matched ones, so leaving it in place turned a caller asking for a
   * handful of rare matches over a large thread into a hard
   * ResultTruncatedError instead of the true (possibly empty) answer.
   */
  for await (const raw of paginateQuery({
    client: context.client,
    params,
    maxItems: Number.POSITIVE_INFINITY,
    maxIterations: Number.POSITIVE_INFINITY,
  })) {
    if (limit !== undefined && yielded >= limit) return;
    const meta = narrowMetaItem(raw);
    if (!meta) {
      context.logger.warn('list: skipped a row that is not a checkpoint meta item', {
        sortKey: raw.SK as string,
      });
      continue;
    }
    if (!passesKeyFilters(meta, checkpointId, before)) continue;
    if (!(await passesMetadataFilter(context, meta, filter))) continue;
    const tuple = await assembleTuple(context, threadId, checkpointNs, meta);
    if (tuple) {
      yield tuple;
      yielded += 1;
    }
  }
}
