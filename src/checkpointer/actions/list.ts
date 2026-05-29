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
  const { threadId, checkpointNs } = readConfigurable(config);
  const before = options?.before?.configurable?.checkpoint_id as string | undefined;
  const filter = options?.filter as Record<string, FilterValue> | undefined;
  const limit = options?.limit;
  const params = beginsWithQuery(
    context.tableName,
    partitionKey(threadId),
    metaSortKeyPrefix(checkpointNs),
  );
  let yielded = 0;
  for await (const raw of paginateQuery({ client: context.client, params })) {
    if (limit !== undefined && yielded >= limit) return;
    const meta = raw as CheckpointMetaItem;
    if (before !== undefined && meta.checkpointId >= before) continue;
    if (filter) {
      const metadata = (await readMetadata(context, meta)) as Record<string, FilterValue>;
      if (!matchesFilter(metadata, filter)) continue;
    }
    const tuple = await assembleTuple(context, threadId, checkpointNs, meta);
    if (tuple) {
      yield tuple;
      yielded += 1;
    }
  }
}
