import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointListOptions, CheckpointTuple } from '@langchain/langgraph-checkpoint';

import { paginateQuery } from '../../shared/dynamodb/paginate';
import { assembleTuple } from '../internal/assemble';
import { readConfigurable } from '../internal/configurable';
import { type FilterValue, matchesFilter } from '../internal/filter-match';
import { readMetadata } from '../internal/item-reader';
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
  for await (const raw of paginateQuery({ client: context.client, params })) {
    if (limit !== undefined && yielded >= limit) return;
    const meta = raw as CheckpointMetaItem;
    if (checkpointId !== undefined && meta.checkpointId !== checkpointId) continue;
    if (before !== undefined && meta.checkpointId >= before) continue;
    if (!(await passesMetadataFilter(context, meta, filter))) continue;
    const tuple = await assembleTuple(context, threadId, checkpointNs, meta);
    if (tuple) {
      yield tuple;
      yielded += 1;
    }
  }
}
