import type { QueryCommandInput, ScanCommandInput } from '@aws-sdk/lib-dynamodb';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointListOptions, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { MAX_KEY_SEGMENT_BYTES } from '../../shared/constants';
import { SAVER_LIST_KEYS } from '../../shared/validation/method-keys';
import { assertObjectShape, assertShape } from '../../shared/validation/option-shape';
import { validateIdentifier, validateInteger } from '../../shared/validation/primitives';
import type { CheckpointMetaItem } from '../types';
import {
  isThreadless,
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
  SORT_KEY_SEPARATOR,
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
  if (isThreadless(config)) {
    return { ...readThreadlessConfigurable(config), threadId: undefined };
  }
  return readConfigurable(config);
}

/**
 * `options.before`'s `checkpoint_id`, validated the way this package's own
 * `configurable.ts` reads the same field off `config`: exactly `undefined`,
 * `null` or `''` means no bound, and anything else — including `0`, `false`
 * or `NaN`, none of which JS truthiness alone would catch — is validated as
 * the sort-key segment it becomes. Checking equality against exactly those
 * three values, rather than truthiness, is deliberately stricter: a bare
 * truthiness check would treat `0`, `false` and `NaN` as absent instead of
 * validating them.
 *
 * Left as an unchecked cast, a caller-supplied non-string reached
 * `ListScope.before`, which is typed `string | undefined`, and then
 * `passesKeyFilters`'s `meta.checkpointId < scope.before` compared a stored
 * string against it — `'1f0a…' < 123` is `false` for every row, so every
 * checkpoint failed the filter and the listing came back silently empty
 * instead of naming the bad value. The same comparison made an *empty*
 * `checkpoint_id` fail every row too, and a malformed one (`'a#b'`) was
 * accepted outright — both are the same defect reached differently, and
 * both are H-10.
 *
 * Accepts: `before` — the caller's `options.before`. Absent is no bound.
 * When given, must be an object — `{}` is legal, since it names no id.
 * `before.configurable.checkpoint_id` is the only field read; the legacy
 * `thread_ts` alias `configurable.ts` falls back to for a *thread's*
 * checkpoint id does not apply here.
 *
 * Returns: the checkpoint id to filter on, or `undefined` for no filter.
 *
 * Throws: ValidationError naming `before` for a non-object `before`, or for
 * a `checkpoint_id` — anything but `undefined`, `null` or `''` — that is not
 * a well-formed identifier (H-10).
 */
function beforeCheckpointId(before: RunnableConfig | undefined): string | undefined {
  if (before === undefined) return undefined;
  assertObjectShape(before, 'before');
  const checkpointId = before.configurable?.checkpoint_id;
  if (checkpointId === undefined || checkpointId === null || checkpointId === '') {
    return undefined;
  }
  validateIdentifier(checkpointId, SORT_KEY_SEPARATOR, 'before', MAX_KEY_SEGMENT_BYTES);
  return checkpointId;
}

/**
 * Reject an `options` bag carrying a key this package does not read, or a
 * `filter` that is not an object. Split out of {@link readListScope} to keep
 * its own complexity under the repo's cap.
 *
 * Accepts: `options` — absent is left alone.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `options.<key>` for an unknown key, or
 * `filter` for a non-object one.
 */
function assertListOptionsShape(options: CheckpointListOptions | undefined): void {
  if (options === undefined) return;
  assertShape(options, SAVER_LIST_KEYS, 'options');
  if (options.filter !== undefined) assertObjectShape(options.filter, 'filter');
}

/**
 * What one `list()` call covers, read from its config and options.
 *
 * Accepts: `config` — must be an object; `null`, `undefined`, an array or any
 * other non-object value is refused naming `config`, before any property is
 * read off it. `config.configurable` — `thread_id` omitted lists every thread
 * and `checkpoint_ns` omitted every namespace, as the reference savers do;
 * every identifier that *is* given is validated either way. `options.limit` —
 * any integer; `0` and below ask for nothing, which `asksForNothing` answers
 * before a request is built, so they are not refused here. `options.before` —
 * an object naming, at most, a `checkpoint_id`; see {@link beforeCheckpointId}.
 * `options.filter` — metadata equality clauses, applied in process; must be an
 * object when given.
 *
 * Returns: the scope every later step reads instead of the raw config.
 *
 * Throws: ValidationError for a malformed identifier; naming `config` for a
 * non-object config — checked before `options`, so a call with both malformed
 * (e.g. `list('x', { bogus: 1 })`) names `config`, not `options.bogus`;
 * naming `limit` for a non-integer — which DynamoDB would otherwise refuse
 * with a raw `ValidationException` after the round trip; naming `before` for
 * a non-object `before` or a malformed `checkpoint_id` (H-10); naming
 * `filter` for a non-object filter; naming `options.<key>` for a key this
 * package does not read.
 */
export function readListScope(config: RunnableConfig, options?: CheckpointListOptions): ListScope {
  const { threadId, checkpointNs, checkpointId } = resolveListIds(config);
  assertListOptionsShape(options);
  if (options?.limit !== undefined) validateInteger(options.limit, 'limit', {});
  return {
    threadId,
    checkpointNs: config.configurable?.checkpoint_ns === undefined ? undefined : checkpointNs,
    checkpointId,
    before: beforeCheckpointId(options?.before),
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
