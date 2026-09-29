/**
 * Hides which rows a checkpoint read issues, with what consistency, and how a
 * checkpoint an older release wrote is read back.
 *
 * A tuple is a META row, a PAYLOAD row and a checkpoint's WRITE rows, read
 * strongly for `getTuple` and eventually for `list`, with expired rows absent
 * however long DynamoDB's sweep lags, and with a pre-v4 checkpoint's `Send`s
 * migrated from its parent's pending writes. The caller asks for a tuple; which
 * reads that takes, and in what order, is decided here.
 */

import type { RunnableConfig } from '@langchain/core/runnables';
import {
  type Checkpoint,
  type CheckpointMetadata,
  type CheckpointPendingWrite,
  type CheckpointTuple,
  maxChannelVersion,
  TASKS,
} from '@langchain/langgraph-checkpoint';

import { nowSeconds } from '../../shared/clock.js';
import type { AttributeMap } from '../../shared/dynamodb/client.js';
import { LIST_SCAN_WARN_THRESHOLD, paginateQuery } from '../../shared/dynamodb/paginate.js';
import { withDynamoDBRetry, retryFor } from '../../shared/dynamodb/retry.js';
import {
  isExpiredRow,
  withoutExpired,
  assertReadableRow,
} from '../../shared/dynamodb/table-schema.js';
import type { ThreadAddress } from './parse.js';
import {
  beginsWithQuery,
  type CheckpointLocation,
  type CheckpointMetaRow,
  type CheckpointPayloadRow,
  type CheckpointWriteRow,
  metaRowKey,
  metaSortKeyPrefix,
  parseHeadRow,
  partitionKey,
  payloadRowKey,
  readCheckpoint,
  readMetadata,
  toPendingWrites,
  writeSortKeyPrefix,
} from './rows.js';
import type { CheckpointerContext } from './setup.js';

/** The thread and namespace a read was asked for. */
export interface ThreadLocation {
  readonly threadId: string;
  readonly checkpointNs: string;
}

/** A checkpoint's parent, whose pending writes a pre-v4 checkpoint's migration reads. */
export interface PendingSendsSource extends ThreadLocation {
  readonly parentCheckpointId: string | undefined;
}

/**
 * Rows one page of the newest-first META read evaluates when the adapter has a
 * `ttl`. The read stops at the first live row of ours, so this decides how
 * many *dead* rows one round trip can step over. At one row per page, a thread
 * whose head has aged out costs one `Query` per expired row, and DynamoDB
 * deletes an expired row within a few days of its `ttl`, with no fixed bound,
 * so that run can be as long as the thread is busy. This is the hottest read
 * the package performs — every graph step begins with it.
 *
 * Without a `ttl` the read asks for one row per page instead. Such an adapter
 * writes no row that can expire, and DynamoDB applies `Limit` before the
 * filter and bills for what it evaluated: fifty rows of about 500 bytes each
 * would cost about seven strongly consistent read units where one row costs
 * one. A table whose rows were written while a `ttl` was set should keep
 * setting it, or its aged-out head costs one `Query` per row.
 */
const LATEST_META_PAGE_SIZE = 50;

/** Per-read options for the payload and writes reads. */
export interface ReadOptions {
  signal?: AbortSignal;
  /** `false` for bulk reads (`list`) that trade read-your-writes for half the read cost. */
  consistent?: boolean;
}

/**
 * The META row a read is about: the one `checkpointId` names, else the newest
 * in the namespace.
 *
 * Accepts: `address` — parsed; its `checkpointId` names the row, and its
 * absence asks for the newest in the namespace. `signal` — aborts the read.
 *
 * Returns: the row, or undefined when there is none — including when every row
 * in the namespace has expired, or when the only rows there belong to another
 * writer.
 *
 * Throws: `FORMAT_UNSUPPORTED` for a row of ours written by a newer version;
 * whatever the read throws.
 *
 * Guarantees: strongly consistent, and expiry is judged here rather than waited
 * for, so a checkpoint past its ttl is absent to every reader however long
 * DynamoDB's sweep lags. The newest-first read returns the first live row of
 * ours and stops there, stepping over expired and foreign rows
 * {@link LATEST_META_PAGE_SIZE} at a time when the adapter has a `ttl`, and
 * reading one row per page when it has none.
 */
export async function fetchTargetMeta(
  context: CheckpointerContext,
  address: ThreadAddress,
  signal?: AbortSignal,
): Promise<CheckpointMetaRow | undefined> {
  const { threadId, checkpointNs, checkpointId } = address;
  // Expired rows are absent to every reader, however long DynamoDB's sweep lags.
  const now = nowSeconds();
  if (checkpointId !== undefined) {
    const result = await withDynamoDBRetry(
      (request) =>
        context.client.get(
          {
            TableName: context.tableName,
            Key: metaRowKey({ threadId, checkpointNs, checkpointId }),
            ConsistentRead: true,
          },
          request,
        ),
      retryFor(context, signal),
    );
    const meta = parseHeadRow(context, result.Item as AttributeMap | undefined);
    return meta && !isExpiredRow(meta, now) ? meta : undefined;
  }
  const params = beginsWithQuery(
    context.tableName,
    partitionKey(threadId),
    metaSortKeyPrefix(checkpointNs),
    {
      // Without a ttl this adapter writes no row that can age out, so the first
      // row read is normally the answer and a larger page only bills for rows it
      // discards. Rows written while a ttl was set keep it, and each of those
      // at the head costs one page here.
      limit: context.ttl === undefined ? 1 : LATEST_META_PAGE_SIZE,
      consistent: true,
    },
  );
  // Both caps stay off, each for its own reason. `maxItems` counts the rows
  // yielded past the server-side filter, and a finite value there would add
  // the probe `paginateQuery` runs to tell a reached cap apart from an
  // exhausted read — more requests, on a read this function already sizes for
  // cost. `maxIterations` is the runaway guard, but a finite value would turn
  // a namespace whose rows have all aged out into a thrown `RESULT_TRUNCATED`
  // where this function documents `undefined`, failing every graph step on
  // exactly the thread shape the page size above exists to serve — including a
  // table whose `ttl` was turned off after rows aged out under it, which reads
  // one row per page and so pages just as far, only at a higher cost. The page
  // size is what bounds the *cost* of the walk, not its length: with a `ttl`
  // it divides the requests a dead head costs by `LATEST_META_PAGE_SIZE`;
  // without one, each request costs exactly one row.
  const rows = paginateQuery({
    retry: retryFor(context, signal),
    signal,
    client: context.client,
    params: withoutExpired(params, now),
    maxItems: Number.POSITIVE_INFINITY,
    maxIterations: Number.POSITIVE_INFINITY,
  });
  for await (const raw of rows) {
    const meta = parseHeadRow(context, raw);
    if (meta && !isExpiredRow(meta, now)) return meta;
  }
  return undefined;
}

/**
 * The PAYLOAD row of one checkpoint.
 *
 * Accepts: `at` — the checkpoint's location. `read.consistent` — defaults to
 * true; `list` passes false and accepts replica lag, since a listing tolerates
 * what a read-your-writes `getTuple` does not.
 *
 * Returns: the row, or undefined when it is not there — the window the ordered
 * PAYLOAD→META write leaves open, which the caller answers as "no checkpoint".
 *
 * Throws: `FORMAT_UNSUPPORTED` for a row a newer release wrote; whatever the
 * read throws.
 */
export async function fetchPayload(
  context: CheckpointerContext,
  at: CheckpointLocation,
  read: ReadOptions = {},
): Promise<CheckpointPayloadRow | undefined> {
  const result = await withDynamoDBRetry(
    (request) =>
      context.client.get(
        {
          TableName: context.tableName,
          Key: payloadRowKey(at),
          ConsistentRead: read.consistent ?? true,
        },
        request,
      ),
    retryFor(context, read.signal),
  );
  const item = result.Item as CheckpointPayloadRow | undefined;
  // A payload of ours written by a newer release fails loudly, as its META row
  // would: decoding it under today's rules is how a checkpoint comes back with
  // state silently missing.
  if (item !== undefined) assertReadableRow(item, 'checkpoint payload');
  return item;
}

/**
 * Every pending write stored for one checkpoint, decoded, in write order.
 *
 * Accepts: `at` — the checkpoint's location. `read.consistent` — omitted reads
 * strongly consistently; `list` passes `false` explicitly and accepts replica
 * lag, `getTuple` passes `true`.
 *
 * Returns: the writes after `dropSupersededWrites` has resolved
 * first-write-wins; a checkpoint with none returns an empty array.
 *
 * Throws: `FORMAT_UNSUPPORTED` for a row a newer release wrote; whatever the
 * query or the payload decode throws.
 *
 * Guarantees: the read is deliberately uncapped. It must be complete to be
 * correct — a `Send` fan-out retried with a changed write order leaves
 * superseded rows behind that would count toward any cap — so past
 * {@link LIST_SCAN_WARN_THRESHOLD} rows the read still succeeds and an operator
 * is told the checkpoint is unusually heavy.
 */
export async function fetchPendingWrites(
  context: CheckpointerContext,
  at: CheckpointLocation,
  read: ReadOptions = {},
): Promise<CheckpointPendingWrite[]> {
  const params = beginsWithQuery(
    context.tableName,
    partitionKey(at.threadId),
    writeSortKeyPrefix(at.checkpointNs, at.checkpointId),
    { ascending: true, consistent: read.consistent ?? true },
  );
  // Unbounded: the read must be complete to be correct, and a Send fan-out
  // retried with a changed write order leaves superseded rows behind that
  // count toward any cap. Past the warning threshold the read still succeeds,
  // but an operator is told the checkpoint is unusually heavy.
  const items: CheckpointWriteRow[] = [];
  for await (const item of paginateQuery({
    retry: retryFor(context, read.signal),
    signal: read.signal,
    client: context.client,
    params,
    maxItems: Number.POSITIVE_INFINITY,
    maxIterations: Number.POSITIVE_INFINITY,
  })) {
    // Checked before `dropSupersededWrites` reads `writeGroup`: that dedup runs
    // on every row regardless of format, and a newer format may give the
    // attribute a different meaning.
    assertReadableRow(item, 'pending write');
    items.push(item as CheckpointWriteRow);
  }
  if (items.length >= LIST_SCAN_WARN_THRESHOLD) {
    context.logger.warn(
      'getTuple: a checkpoint carries very many pending-write rows; the read is complete but slow',
      {
        threadId: at.threadId,
        checkpointId: at.checkpointId,
        rows: items.length,
      },
    );
  }
  return toPendingWrites(context, items, at.threadId, read.signal);
}

/** How a tuple is assembled: cancellation, read consistency, and metadata already decoded by the caller. */
export interface AssembleOptions {
  signal?: AbortSignal;
  /** `true` for `getTuple` (read-your-writes), `false` for the eventually-consistent `list` path. */
  consistent: boolean;
  /** Metadata the caller decoded to apply a filter, so it is not decoded (or downloaded) twice. */
  metadata?: CheckpointMetadata;
}

/** Build a config that addresses a specific checkpoint. */
function configFor(threadId: string, checkpointNs: string, checkpointId: string): RunnableConfig {
  return {
    configurable: { thread_id: threadId, checkpoint_ns: checkpointNs, checkpoint_id: checkpointId },
  };
}

/**
 * A full {@link CheckpointTuple} built from a META row.
 *
 * Accepts: `thread` — the **caller's** location, never the row's: `thread.threadId`
 * scopes which S3 object the row may point at, so it must come from the
 * partition the caller asked for; `thread.checkpointNs` is its namespace.
 * `options.metadata` — already decoded by a filtered `list`, so a filtered
 * listing decodes and downloads each metadata blob once, not twice.
 * `options.consistent` — true for `getTuple`, false for `list`.
 *
 * Returns: the tuple, with `parentConfig` set only when the row names a parent;
 * `undefined` when the PAYLOAD row is absent — the window the ordered
 * PAYLOAD→META write leaves open, and the same answer a caller gets for a
 * checkpoint that does not exist.
 *
 * Throws: whatever the reads and decodes throw.
 */
export async function assembleTuple(
  context: CheckpointerContext,
  thread: ThreadLocation,
  meta: CheckpointMetaRow,
  options: AssembleOptions,
): Promise<CheckpointTuple | undefined> {
  const read = { signal: options.signal, consistent: options.consistent };
  const at: CheckpointLocation = { ...thread, checkpointId: meta.checkpointId };
  const payload = await fetchPayload(context, at, read);
  if (!payload) return undefined;
  const [checkpoint, metadata, pendingWrites] = await Promise.all([
    readCheckpoint(context, payload, thread.threadId, options.signal).then((stored) =>
      migratePendingSends(
        context,
        stored,
        { ...thread, parentCheckpointId: meta.parentCheckpointId },
        read,
      ),
    ),
    options.metadata ?? readMetadata(context, meta, thread.threadId, options.signal),
    fetchPendingWrites(context, at, read),
  ]);
  const tuple: CheckpointTuple = {
    config: configFor(thread.threadId, thread.checkpointNs, meta.checkpointId),
    checkpoint,
    metadata,
    pendingWrites,
  };
  if (meta.parentCheckpointId !== undefined) {
    tuple.parentConfig = configFor(thread.threadId, thread.checkpointNs, meta.parentCheckpointId);
  }
  return tuple;
}

/**
 * Pre-v4 checkpoints kept a task's `Send`s as `__pregel_tasks` pending writes
 * on the parent rather than in the checkpoint itself. Reading such a
 * checkpoint rebuilds `channel_values[TASKS]` from those writes and stamps
 * the channel with the highest version the checkpoint already carries (or
 * the first version when it carries none), exactly as the reference savers
 * do, so a thread written before LangGraph 0.2 still resumes.
 *
 * Accepts: `checkpoint` — any version. `parent` — the checkpoint's own thread
 * and namespace, plus `parent.parentCheckpointId`, the parent whose pending
 * writes hold the sends; absent means there is nowhere to migrate from.
 * `read` — cancellation and consistency for the pending-writes read.
 *
 * Returns: the checkpoint untouched when it is v4 or has no parent, and
 * otherwise a copy with `channel_values[TASKS]` rebuilt. The input is never
 * mutated.
 *
 * Throws: whatever reading the parent's pending writes throws.
 */
export async function migratePendingSends(
  context: CheckpointerContext,
  checkpoint: Checkpoint,
  parent: PendingSendsSource,
  read: ReadOptions,
): Promise<Checkpoint> {
  if (checkpoint.v >= 4 || parent.parentCheckpointId === undefined) return checkpoint;
  const writes = await fetchPendingWrites(
    context,
    {
      threadId: parent.threadId,
      checkpointNs: parent.checkpointNs,
      checkpointId: parent.parentCheckpointId,
    },
    read,
  );
  const sends = writes.filter(([, channel]) => channel === TASKS).map(([, , value]) => value);
  const versions = Object.values(checkpoint.channel_versions);
  return {
    ...checkpoint,
    channel_values: { ...checkpoint.channel_values, [TASKS]: sends },
    channel_versions: {
      ...checkpoint.channel_versions,
      [TASKS]: versions.length > 0 ? maxChannelVersion(...versions) : 1,
    },
  };
}
