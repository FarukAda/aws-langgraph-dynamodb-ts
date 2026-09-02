import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointListOptions, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import type { CheckpointMetaItem } from '../types';
import { readConfigurable } from './configurable';
import { type FilterValue, matchesFilter } from './filter-match';
import { readMetadata } from './item-reader';
import { metaAnyNamespacePrefix, metaSortKey, metaSortKeyPrefix, partitionKey } from './keys';
import { beginsWithQuery } from './query';
import type { CheckpointerContext } from './setup';

/** What one `list()` call covers, read once from its config and options. */
export interface ListScope {
  threadId: string;
  /** Undefined when the caller gave no `checkpoint_ns`: every namespace of the thread is listed. */
  checkpointNs: string | undefined;
  checkpointId: string | undefined;
  before: string | undefined;
  filter: Record<string, FilterValue> | undefined;
  limit: number | undefined;
  signal: AbortSignal | undefined;
}

/**
 * Read the scope. Unlike `getTuple`, which addresses the root namespace when
 * none is given, `list()` without a `checkpoint_ns` covers every namespace, as
 * the reference savers do; `readConfigurable` still validates the identifiers.
 */
export function readListScope(config: RunnableConfig, options?: CheckpointListOptions): ListScope {
  const { threadId, checkpointNs, checkpointId } = readConfigurable(config);
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
 * The META query for a scope. A metadata filter means rows may be dropped
 * client-side, so only an unfiltered list passes the caller's limit through as
 * the page size. With an explicit namespace `before` bounds the key range so
 * rows newer than it are never read; across namespaces ids do not share one
 * order and `before` is applied in-process.
 */
export function listQuery(context: CheckpointerContext, scope: ListScope): QueryCommandInput {
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
 * True when `meta` passes the key-level `before` filter (strictly older
 * checkpoints). An explicit `checkpoint_id` is fetched directly rather than
 * filtered, so it needs no check here.
 */
export function passesKeyFilters(meta: CheckpointMetaItem, scope: ListScope): boolean {
  return scope.before === undefined || meta.checkpointId < scope.before;
}

/** Outcome of the metadata filter: rejected, or accepted with any metadata decoded on the way. */
export type MetadataVerdict = { pass: false } | { pass: true; metadata?: CheckpointMetadata };

/**
 * Apply the optional metadata-equality filter. The metadata decoded here is
 * handed to the tuple assembly, so a filtered list decodes (and, when offloaded,
 * downloads) each metadata blob once instead of twice.
 */
export async function passesMetadataFilter(
  context: CheckpointerContext,
  meta: CheckpointMetaItem,
  scope: ListScope,
): Promise<MetadataVerdict> {
  if (!scope.filter) return { pass: true };
  const metadata = await readMetadata(context, meta, scope.threadId);
  return matchesFilter(metadata as Record<string, FilterValue>, scope.filter)
    ? { pass: true, metadata }
    : { pass: false };
}
