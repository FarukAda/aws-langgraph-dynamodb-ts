import type { QueryCommandInput, ScanCommandInput } from '@aws-sdk/lib-dynamodb';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointListOptions, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { ValidationError } from '../../shared/errors/errors';
import type { CheckpointMetaItem } from '../types';
import {
  readConfigurable,
  readThreadlessConfigurable,
  type ResolvedConfigurable,
} from './configurable';
import { type FilterValue, matchesFilter } from './filter-match';
import { readMetadata } from './item-reader';
import {
  checkpointerPartitionPrefix,
  metaAnyNamespacePrefix,
  metaSortKey,
  metaSortKeyPrefix,
  partitionKey,
} from './keys';
import { beginsWithQuery } from './query';
import type { CheckpointerContext } from './setup';

/** What one `list()` call covers, read once from its config and options. */
export interface ListScope {
  /** Undefined when the caller gave no `thread_id`: every thread in the table is listed. */
  threadId: string | undefined;
  /** Undefined when the caller gave no `checkpoint_ns`: every namespace of the thread is listed. */
  checkpointNs: string | undefined;
  checkpointId: string | undefined;
  before: string | undefined;
  filter: Record<string, FilterValue> | undefined;
  limit: number | undefined;
  signal: AbortSignal | undefined;
}

/** The identifiers a list config names; a config without a thread is still validated for the ids it gives. */
function resolveListIds(
  config: RunnableConfig,
): Omit<ResolvedConfigurable, 'threadId'> & { threadId: string | undefined } {
  if (config.configurable?.thread_id === undefined) {
    return { ...readThreadlessConfigurable(config), threadId: undefined };
  }
  return readConfigurable(config);
}

/**
 * Refuse a page size DynamoDB would reject after the round trip. A limit of 0
 * or below is not refused: it asks for nothing, which `asksForNothing` answers
 * before a request is built.
 */
function assertIntegerLimit(limit: number | undefined): void {
  if (limit !== undefined && !Number.isInteger(limit)) {
    throw new ValidationError('limit must be an integer', 'limit');
  }
}

/**
 * What one `list()` call covers, read from its config and options.
 *
 * Accepts: `config.configurable` — `thread_id` omitted lists every thread and
 * `checkpoint_ns` omitted every namespace, as the reference savers do; every
 * identifier that *is* given is validated either way. `options.limit` — a
 * non-negative integer; `0` and below ask for nothing and are answered without
 * a request. `options.before` — read for its `checkpoint_id` only.
 * `options.filter` — metadata equality clauses, applied in process.
 *
 * Returns: the scope every later step reads instead of the raw config.
 *
 * Throws: ValidationError for a malformed identifier, and naming `limit` for a
 * non-integer — which DynamoDB would otherwise refuse with a raw
 * `ValidationException` after the round trip.
 */
export function readListScope(config: RunnableConfig, options?: CheckpointListOptions): ListScope {
  const { threadId, checkpointNs, checkpointId } = resolveListIds(config);
  assertIntegerLimit(options?.limit);
  return {
    threadId,
    checkpointNs: config.configurable?.checkpoint_ns === undefined ? undefined : checkpointNs,
    checkpointId,
    before: options?.before?.configurable?.checkpoint_id as string | undefined,
    filter: options?.filter as Record<string, FilterValue> | undefined,
    limit: options?.limit,
    signal: config.signal,
  };
}

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
  scope: ListScope & { threadId: string },
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
 * The table `Scan` a thread-less `list()` runs.
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
    ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
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
 * Throws: nothing.
 */
export function passesKeyFilters(meta: CheckpointMetaItem, scope: ListScope): boolean {
  return (
    (scope.before === undefined || meta.checkpointId < scope.before) &&
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
  const metadata = await readMetadata(context, meta, meta.threadId);
  return matchesFilter(metadata as Record<string, FilterValue>, scope.filter)
    ? { pass: true, metadata }
    : { pass: false };
}
