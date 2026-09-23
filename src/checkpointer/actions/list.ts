import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointListOptions, CheckpointTuple } from '@langchain/langgraph-checkpoint';

import { nowSeconds } from '../../shared/clock';
import { LIST_SCAN_WARN_THRESHOLD } from '../../shared/constants';
import { isExpiredRow } from '../../shared/dynamodb/table-schema';
import { assembleTuple } from '../internal/assemble';
import { fetchTargetMeta } from '../internal/fetch';
import { metaRows, narrowOrWarn } from '../internal/list-rows';
import { passesKeyFilters, passesMetadataFilter } from '../internal/list-scope';
import {
  type CheckpointId,
  type CheckpointNs,
  type ListScope,
  parseListScope,
  type ThreadId,
} from '../internal/parse';
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
  scope: OneRowScope,
): AsyncGenerator<CheckpointTuple> {
  const meta = await fetchTargetMeta(
    context,
    {
      threadId: scope.threadId,
      checkpointNs: scope.checkpointNs,
      checkpointId: scope.checkpointId,
    },
    scope.signal,
  );
  if (!meta) return;
  const tuple = await tupleFor(context, meta, scope);
  if (tuple) yield tuple;
}

/**
 * True when the caller asked for no tuples at all. Answered before any request
 * is built: DynamoDB rejects `Limit: 0`, and yielding one tuple and only then
 * testing the limit returns a result the caller did not ask for. The reference
 * saver returns nothing here (`@langchain/langgraph-checkpoint@1.1.5`
 * `dist/memory.js:172`).
 *
 * Exactly `0`, not "zero or less": a negative limit is refused by
 * {@link parseListScope} before this runs, so treating one as a request for
 * nothing would be a branch no call could reach.
 */
function asksForNothing(scope: ListScope): boolean {
  return scope.limit === 0;
}

/** A scope that names one row: a thread, a namespace and a checkpoint. */
type OneRowScope = ListScope & {
  threadId: ThreadId;
  checkpointNs: CheckpointNs;
  checkpointId: CheckpointId;
};

/**
 * True when the scope names exactly one row, which is only so once the
 * namespace is known. A `checkpoint_id` without a `checkpoint_ns` may address a
 * checkpoint in any namespace — a subgraph's, for instance — so the read stays
 * namespace-wide and `passesKeyFilters` narrows it to that id.
 */
function addressesOneRow(scope: ListScope): scope is OneRowScope {
  return (
    scope.threadId !== undefined &&
    scope.checkpointId !== undefined &&
    scope.checkpointNs !== undefined
  );
}

/**
 * Yield checkpoint tuples for a thread, newest first: every namespace when the
 * config names none (grouped by namespace, newest first within each), else the
 * one namespace given. Without a `thread_id` every thread in the table is
 * listed: through a table scan, as the reference savers do, which is unordered
 * across threads, or through the recency index when `indexName` is set. Either
 * read is cross-tenant by construction. Honors `options.before` (only
 * checkpoints older than the given id), `options.filter` (metadata equality),
 * and `options.limit` (max tuples yielded; the read stops right after the
 * yield that reaches it).
 *
 * Accepts: `config` — `thread_id` scopes the read to one thread and its absence
 * lists every thread in the table, through a scan as the reference savers do or
 * through the recency index when `indexName` is set; `checkpoint_ns` scopes to
 * one namespace and its absence spans every namespace of the thread.
 * `options.before` — only checkpoints older than that id. `options.filter` —
 * metadata equality. `options.limit` — at most this many tuples, up to the
 * package's page ceiling; `0` yields nothing, which is what the reference
 * returns, and a negative value is refused.
 *
 * Returns: an async generator over the tuples, newest first within a namespace,
 * unordered across threads on the scan path. The read stops right after the
 * yield that reaches `limit`, and abandoning the generator stops it too.
 *
 * Throws: `VALIDATION`, from the first `.next()` and before any read, for
 * a config of the wrong shape (`config`, `configurable`, `signal`), a
 * malformed identifier, or options that fail the checks
 * {@link parseListScope} makes;
 * `FORMAT_UNSUPPORTED` for a row of ours written by a newer version; whatever
 * the reads and decodes throw.
 *
 * Guarantees: eventually consistent — a listing tolerates the replica lag
 * `getTuple` does not. The read is deliberately unbounded: this generator
 * streams and never accumulates, `limit` returns early, and a raw-row cap would
 * turn a caller asking for a handful of rare matches over a large thread into a
 * hard error instead of the true (possibly empty) answer. Past the warning
 * threshold an operator is told to narrow the filter or pass a limit.
 */
export async function* listCheckpoints(
  context: CheckpointerContext,
  config: RunnableConfig,
  options?: CheckpointListOptions,
): AsyncGenerator<CheckpointTuple> {
  const scope = parseListScope(config, options);
  if (asksForNothing(scope)) return;
  if (addressesOneRow(scope)) {
    yield* listOne(context, scope);
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
