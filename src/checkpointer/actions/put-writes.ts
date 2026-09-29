/**
 * Hides how one `putWrites` call's rows are known to be one call's.
 *
 * Every call draws a write group from a strictly monotonic ULID factory, and
 * that one id serves three ends: the object id each offloaded write is uploaded
 * under (record 4), the owner a guard rejection is compared against to tell a
 * rival call from this call's own retry, and the order the read side uses to
 * pick the earliest call that wrote a channel. A caller passes writes and a
 * task id and never sees the group.
 */

import type { RunnableConfig } from '@langchain/core/runnables';
import type { PendingWrite } from '@langchain/langgraph-checkpoint';

import { createUlidFactory } from '../../shared/ulid.js';
import { calculateTtlTimestamp } from '../../shared/validation/ttl.js';
import { parsePutWritesRequest } from '../internal/parse.js';
import { commitPendingWrites } from '../internal/pending-writes.js';
import { buildWriteRows } from '../internal/rows.js';
import type { CheckpointerContext } from '../internal/setup.js';

/**
 * Stamps each `putWrites` call, identifying its rows as one group.
 *
 * It is what a guard rejection is compared against to tell "another call holds
 * this row" from "my own retry does", it is the object id every offloaded write
 * of the call is uploaded under, and — because ULIDs are lexicographically
 * time-ordered, and this factory is strictly monotonic even within a single
 * millisecond — it lets the read side identify the *earliest* call that wrote a
 * given channel (see `dropSupersededWrites`). A random UUID would identify a
 * call just as well but carries no ordering, which would leave that choice
 * arbitrary.
 */
const nextWriteGroup = createUlidFactory();

/**
 * Persist a task's intermediate writes for a checkpoint, one row per write.
 *
 * Accepts: `config` — must name a `checkpoint_id`, since writes always attach
 * to a checkpoint. `writes` — one task's, in order; their channels are
 * validated before anything is encoded or uploaded. `taskId` — validated as the
 * sort-key segment it becomes. `config.signal` — cancels the writes' retries;
 * checked before anything is encoded.
 *
 * Returns: nothing. Every write is attempted; a regular write that loses its
 * first-write-wins race is a normal outcome, not a failure.
 *
 * Throws: `VALIDATION` naming `config`, `configurable` or `signal` for a
 * config of the wrong shape; `thread_id`, `checkpoint_ns`, `checkpoint_id` or
 * `thread_ts` for a malformed identifier, and `checkpoint_id` when the config
 * names none; `taskId`, `writes`, `channel`, `sortKey` — every one of them
 * before anything is encoded or uploaded — `payload` or `s3Key`; the first
 * genuine write failure, after every write has settled and the cleanup has
 * run.
 *
 * Guarantees: regular writes are first-write-wins, matching the reference
 * checkpointer; special negative-index writes always overwrite (see
 * {@link commitPendingWrites}). Cleanup of this call's own uploads only ever
 * targets uploads confirmed unreferenced: a verified non-commit, or a guard
 * rejection whose returned row provably belongs to another call. A special write's superseded
 * payload is released only once the write that superseded it committed. An
 * upload can leak. A payload refused partway through the encode releases the
 * objects the earlier writes of the same call had already uploaded, before the
 * refusal reaches the caller and while no row of the call exists. Every
 * offloaded write of this call is uploaded under the call's own `writeGroup`,
 * so no row another call writes names one of this call's uploads, and no
 * release reads the row again first.
 */
export async function putWrites(
  context: CheckpointerContext,
  config: RunnableConfig,
  writes: PendingWrite[],
  taskId: string,
): Promise<void> {
  const request = parsePutWritesRequest(config, writes, taskId);
  if (request.writes.length === 0) return;
  const ttlTimestamp = context.ttl ? calculateTtlTimestamp(context.ttl) : undefined;
  const items = await buildWriteRows(context, request, nextWriteGroup(), ttlTimestamp);
  await commitPendingWrites(context, {
    threadId: request.address.threadId,
    items,
    signal: request.signal,
  });
}
