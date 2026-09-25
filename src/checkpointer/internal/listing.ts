/**
 * Hides where a listing's META rows come from and which of them pass its filters.
 *
 * A listing that names a thread is a partition query; one that does not is a
 * recency-index read when the table carries the index and a table scan when it
 * does not (record 8). Whichever it is, rows are narrowed to this adapter's own,
 * and a row passes only when its key fields match the scope and, when the caller
 * gave a filter, its decoded metadata equals the filter clause for clause.
 */

import { isDeepStrictEqual } from 'node:util';

import type { QueryCommandInput, ScanCommandInput } from '@aws-sdk/lib-dynamodb';
import type { CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { DEFAULT_READ_CONCURRENCY } from '../../shared/concurrency';
import type { AttributeMap } from '../../shared/dynamodb/client';
import { paginateQuery, paginateScan } from '../../shared/dynamodb/paginate';
import { DEFAULT_INDEX_SHARDS, iterateRecencyIndex } from '../../shared/dynamodb/recency-index';
import { retryFor } from '../../shared/dynamodb/retry';
import {
  compareSortKeys,
  PARTITION_KEY_ATTRIBUTE,
  SORT_KEY_ATTRIBUTE,
  withoutExpired,
} from '../../shared/dynamodb/table-schema';
import { truncateForLog } from '../../shared/logging/truncate';
import type { FilterValue, ListScope, ThreadId } from './parse';
import {
  beginsWithQuery,
  checkpointerPartitionPrefix,
  type CheckpointMetaRow,
  metaAnyNamespacePrefix,
  metaSortKey,
  metaSortKeyPrefix,
  parseMetaRow,
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
 * an astral id the two disagree, so `<` here would turn the redundant pass
 * into a second, different filter that drops rows the query rightly returned.
 * Every id in one namespace shares its sort key's prefix, so comparing the id
 * is comparing the sort key.
 *
 * Throws: nothing.
 */
export function passesKeyFilters(meta: CheckpointMetaRow, scope: ListScope): boolean {
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
  meta: CheckpointMetaRow,
  scope: ListScope,
): Promise<MetadataVerdict> {
  if (!scope.filter) return { pass: true };
  const metadata = await readMetadata(context, meta, meta.threadId, scope.signal);
  return matchesFilter(metadata, scope.filter) ? { pass: true, metadata } : { pass: false };
}

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
): AsyncGenerator<AttributeMap> {
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
): AsyncGenerator<AttributeMap> {
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
export function parseListedRow(
  context: CheckpointerContext,
  raw: AttributeMap,
): CheckpointMetaRow | undefined {
  const meta = parseMetaRow(raw);
  if (!meta) {
    context.logger.warn('list: skipped a row that is not a checkpoint meta item', {
      sortKey: truncateForLog(raw.SK as string),
    });
  }
  return meta;
}

/** The value `metadata` holds at `key`, or undefined when it holds no such own property. */
function ownValue(metadata: Record<string, FilterValue>, key: string): FilterValue | undefined {
  if (metadata === null || typeof metadata !== 'object') return undefined;
  return Object.hasOwn(metadata, key) ? metadata[key] : undefined;
}

/**
 * Whether `metadata` satisfies every clause of `filter`.
 *
 * Accepts: `metadata` — a checkpoint's decoded metadata. Declared as a record,
 * but a row can hold anything its writer stored, including `null` and a scalar;
 * such a value has no own properties and so matches no clause.
 * `filter` — the caller's equality clauses; `{}` matches everything.
 *
 * Returns: true when every key of `filter` is an **own** property of `metadata`
 * with a deeply equal value. Equality is structural and key-order-independent
 * for nested objects, order-significant for arrays, and type-strict — `3` does
 * not match `'3'`.
 *
 * Throws: nothing. A filtered `list()` walks every row, so a single row whose
 * metadata is not an object must not fail the listing.
 *
 * Guarantees: only own properties count, so a filter on `constructor` or
 * `toString` compares against nothing rather than against the prototype's
 * function — the same rule the store's filter applies.
 */
export function matchesFilter(
  metadata: Record<string, FilterValue>,
  filter: Record<string, FilterValue>,
): boolean {
  return Object.entries(filter).every(([key, value]) =>
    isDeepStrictEqual(ownValue(metadata, key), value),
  );
}
