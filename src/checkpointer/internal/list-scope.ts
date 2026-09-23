import type { QueryCommandInput, ScanCommandInput } from '@aws-sdk/lib-dynamodb';
import type { CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import {
  compareSortKeys,
  PARTITION_KEY_ATTRIBUTE,
  SORT_KEY_ATTRIBUTE,
} from '../../shared/dynamodb/table-schema';
import { matchesFilter } from './filter-match';
import type { ListScope, ThreadId } from './parse';
import {
  beginsWithQuery,
  checkpointerPartitionPrefix,
  type CheckpointMetaItem,
  metaAnyNamespacePrefix,
  metaSortKey,
  metaSortKeyPrefix,
  partitionKey,
  readMetadata,
} from './rows';
import type { CheckpointerContext } from './setup';

/**
 * The META query for a scope that names a thread.
 *
 * Accepts: `scope.filter` — its presence means rows may be dropped client-side,
 * so only an unfiltered list passes the caller's `limit` through as the page
 * size; passing it through a filtered read would cut the page short of matches
 * that exist. `scope.checkpointNs` — absent spans every namespace of the
 * thread. `scope.before` — bounds the key range only with an explicit
 * namespace, since across namespaces ids do not share one order; it is applied
 * in-process otherwise.
 *
 * Returns: the Query input.
 *
 * Throws: nothing.
 */
export function listQuery(
  context: CheckpointerContext,
  scope: ListScope & { threadId: ThreadId },
): QueryCommandInput {
  const partition = partitionKey(scope.threadId);
  const limit = scope.filter === undefined ? scope.limit : undefined;
  if (scope.checkpointNs === undefined) {
    return beginsWithQuery(context.tableName, partition, metaAnyNamespacePrefix(), { limit });
  }
  return beginsWithQuery(context.tableName, partition, metaSortKeyPrefix(scope.checkpointNs), {
    limit,
    beforeSortKey:
      scope.before === undefined ? undefined : metaSortKey(scope.checkpointNs, scope.before),
  });
}

/**
 * The table `Scan` a thread-less `list()` runs when no recency index is
 * configured.
 *
 * Accepts: `scope.checkpointNs` — narrows the filter to one namespace when the
 * caller gave one.
 *
 * Returns: the Scan input, filtered to this adapter's META rows. It is what the
 * reference savers do for a config without a thread, and on DynamoDB it costs a
 * read of the whole table — cross-tenant by construction, which the public
 * documentation says outright.
 *
 * Throws: nothing.
 */
export function listScan(context: CheckpointerContext, scope: ListScope): ScanCommandInput {
  return {
    TableName: context.tableName,
    FilterExpression: 'begins_with(#pk, :pk) AND begins_with(#sk, :sk)',
    ExpressionAttributeNames: { '#pk': PARTITION_KEY_ATTRIBUTE, '#sk': SORT_KEY_ATTRIBUTE },
    ExpressionAttributeValues: {
      ':pk': checkpointerPartitionPrefix(),
      ':sk':
        scope.checkpointNs === undefined
          ? metaAnyNamespacePrefix()
          : metaSortKeyPrefix(scope.checkpointNs),
    },
  };
}

/**
 * Whether `meta` passes the key-level filters.
 *
 * Accepts: any narrowed META row, from a query or a scan.
 *
 * Returns: whether it is strictly older than `before` and — on a table scan,
 * where the key condition cannot narrow them — in the requested namespace and,
 * when one is given, the requested checkpoint. Applied to query results too,
 * which is redundant there and free: one rule, one place.
 *
 * "Older" is {@link compareSortKeys}, because on the query path the same bound
 * is already a `BETWEEN` on the composed sort key, which DynamoDB evaluates in
 * UTF-8 byte order. JavaScript's `<` orders UTF-16 code units instead, and at
 * an astral id the two disagree — which turned the redundant pass into a
 * second, different filter that dropped rows the query had rightly returned.
 * Every id in one namespace shares its sort key's prefix, so comparing the id
 * is comparing the sort key.
 *
 * Throws: nothing.
 */
export function passesKeyFilters(meta: CheckpointMetaItem, scope: ListScope): boolean {
  return (
    (scope.before === undefined || compareSortKeys(meta.checkpointId, scope.before) < 0) &&
    (scope.checkpointNs === undefined || meta.checkpointNs === scope.checkpointNs) &&
    (scope.checkpointId === undefined || meta.checkpointId === scope.checkpointId)
  );
}

/** Outcome of the metadata filter: rejected, or accepted with any metadata decoded on the way. */
export type MetadataVerdict = { pass: false } | { pass: true; metadata?: CheckpointMetadata };

/**
 * Apply the optional metadata-equality filter.
 *
 * Accepts: `scope.filter` — absent means every row passes and nothing is
 * decoded. `meta` — already bound to its partition, so the scope its metadata
 * is read under is its own.
 *
 * Returns: whether the row passes and, when it does and a filter forced the
 * decode, the metadata itself — handed to the tuple assembly, so a filtered
 * list decodes (and, when offloaded, downloads) each blob once instead of
 * twice.
 *
 * Throws: whatever the decode throws. Metadata that decodes to something that
 * is not an object matches no filter clause rather than failing the listing.
 */
export async function passesMetadataFilter(
  context: CheckpointerContext,
  meta: CheckpointMetaItem,
  scope: ListScope,
): Promise<MetadataVerdict> {
  if (!scope.filter) return { pass: true };
  const metadata = await readMetadata(context, meta, meta.threadId, scope.signal);
  return matchesFilter(metadata, scope.filter) ? { pass: true, metadata } : { pass: false };
}
