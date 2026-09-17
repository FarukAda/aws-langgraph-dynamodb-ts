import type { RunnableConfig } from '@langchain/core/runnables';
import type { PendingWrite } from '@langchain/langgraph-checkpoint';

import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { ValidationError } from '../../shared/errors/errors';
import { createUlidFactory } from '../../shared/ulid';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import { readConfigurable } from '../internal/configurable';
import { buildWriteItems } from '../internal/item-writer';
import { writeRegularItems } from '../internal/regular-write';
import type { CheckpointerContext } from '../internal/setup';
import { writeSpecialItemsWithCleanup } from '../internal/special-write-cleanup';
import { validateTaskId, validateWrites } from '../internal/validation';
import type { CheckpointWriteItem } from '../types';

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
 * Best-effort delete the offloaded objects of uploads this call's rows do not
 * reference, if an offloader is configured. Each key ends in this call's own
 * `writeGroup`, so a row another call wrote in its place never names it.
 */
async function cleanUpItems(
  context: CheckpointerContext,
  dead: CheckpointWriteItem[],
): Promise<void> {
  if (!context.offloader) return;
  await cleanUpS3Orphans(
    context.offloader,
    collectS3Keys(dead.map((item) => item.value)),
    'putWrites',
    context.logger,
  );
}

/**
 * Persist a task's intermediate writes for a checkpoint, one item per write.
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
 * Throws: ValidationError naming `config`, `configurable` or `signal` for a
 * config of the wrong shape; `thread_id`, `checkpoint_ns`, `checkpoint_id` or
 * `thread_ts` for a malformed identifier, and `checkpoint_id` when the config
 * names none; `taskId`, `writes`, `channel`, `sortKey`, `payload` or `s3Key`;
 * the first genuine write failure, after every write has settled and the
 * cleanup has run.
 *
 * Guarantees: regular writes are first-write-wins, matching the reference
 * checkpointer; special negative-index writes always overwrite (see
 * {@link writeSpecialItemsWithCleanup}). Cleanup of this call's own uploads
 * only ever targets uploads confirmed unreferenced (see
 * {@link writeRegularItems}): a verified non-commit, or a guard rejection whose
 * returned row provably belongs to another call. A special write's superseded
 * payload is released only once the write that superseded it committed. An
 * upload can leak. Every offloaded write of this call is uploaded under the
 * call's own `writeGroup`, so no row another call writes names one of this
 * call's uploads, and no release reads the row again first.
 */
export async function putWrites(
  context: CheckpointerContext,
  config: RunnableConfig,
  writes: PendingWrite[],
  taskId: string,
): Promise<void> {
  validateTaskId(taskId);
  const { threadId, checkpointNs, checkpointId } = readConfigurable(config);
  const signal = config.signal;
  if (checkpointId === undefined) {
    throw new ValidationError('checkpoint_id is required to store writes', 'checkpoint_id');
  }
  validateWrites(writes);
  if (writes.length === 0) return;
  const ttlTimestamp = context.ttl ? calculateTtlTimestamp(context.ttl) : undefined;
  const items = await buildWriteItems(
    context,
    threadId,
    checkpointNs,
    checkpointId,
    taskId,
    writes,
    nextWriteGroup(),
    ttlTimestamp,
  );
  const special = items.filter((item) => item.index < 0);
  const regular = items.filter((item) => item.index >= 0);
  const [specialError, regularOutcome] = await Promise.all([
    writeSpecialItemsWithCleanup(context, threadId, special, signal),
    writeRegularItems(context, regular, signal),
  ]);
  await cleanUpItems(context, regularOutcome.deadUploads);
  const firstError = specialError ?? regularOutcome.error;
  if (firstError) throw firstError;
}
