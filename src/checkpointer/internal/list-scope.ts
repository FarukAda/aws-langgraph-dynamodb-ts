import type { QueryCommandInput, ScanCommandInput } from '@aws-sdk/lib-dynamodb';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointListOptions, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import type { CheckpointMetaItem } from '../types';
import { readConfigurable, type ResolvedConfigurable } from './configurable';
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
import { validateCheckpointId, validateCheckpointNs } from './validation';

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

/** The identifiers of a config that names no thread, validated the same way. */
function readThreadless(config: RunnableConfig): ResolvedConfigurable {
  const checkpointNs = (config.configurable?.checkpoint_ns as string | undefined) ?? '';
  validateCheckpointNs(checkpointNs);
  const rawId = config.configurable?.checkpoint_id as string | undefined;
  const checkpointId = rawId ? rawId : undefined;
  if (checkpointId !== undefined) validateCheckpointId(checkpointId);
  return { threadId: '', checkpointNs, checkpointId };
}

/** The identifiers a list config names; a config without a thread is still validated for the ids it gives. */
function resolveListIds(
  config: RunnableConfig,
): Omit<ResolvedConfigurable, 'threadId'> & { threadId: string | undefined } {
  if (config.configurable?.thread_id === undefined) {
    return { ...readThreadless(config), threadId: undefined };
  }
  return readConfigurable(config);
}

/**
 * Read the scope. Unlike `getTuple`, which addresses the root namespace when
 * none is given, `list()` without a `checkpoint_ns` covers every namespace,
 * and without a `thread_id` every thread, as the reference savers do; the
 * identifiers that are given are validated either way.
 */
export function readListScope(config: RunnableConfig, options?: CheckpointListOptions): ListScope {
  const { threadId, checkpointNs, checkpointId } = resolveListIds(config);
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
 * The table `Scan` a thread-less `list()` runs: every checkpointer META row,
 * narrowed to one namespace when the caller gave one. It is what the
 * reference savers do for a config without a thread, and on DynamoDB it costs
 * a read of the whole table.
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
 * True when `meta` passes the key-level filters: strictly older than `before`,
 * and — on a table scan, where the key condition cannot narrow them — in the
 * requested namespace and, when one is given, the requested checkpoint.
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
  const metadata = await readMetadata(context, meta, meta.threadId);
  return matchesFilter(metadata as Record<string, FilterValue>, scope.filter)
    ? { pass: true, metadata }
    : { pass: false };
}
