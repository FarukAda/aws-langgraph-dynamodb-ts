import type { RunnableConfig } from '@langchain/core/runnables';
import type { PendingWrite } from '@langchain/langgraph-checkpoint';

import { releasableS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { ValidationError } from '../../shared/errors/errors';
import { createUlidFactory } from '../../shared/ulid';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import { readConfigurable } from '../internal/configurable';
import { buildWriteItems } from '../internal/item-writer';
import { type DeadUpload, writeRegularItems } from '../internal/regular-write';
import type { CheckpointerContext } from '../internal/setup';
import { writeSpecialItemsWithCleanup } from '../internal/special-write-cleanup';
import { validateTaskId, validateWrites } from '../internal/validation';

/**
 * Stamps each `putWrites` call, identifying its rows as one group.
 *
 * It is what a guard rejection is compared against to tell "another call holds
 * this row" from "my own retry does", and — because ULIDs are lexicographically
 * time-ordered, and this factory is strictly monotonic even within a single
 * millisecond — it lets the read side identify the *earliest* call that wrote a
 * given channel (see `dropSupersededWrites`). A random UUID would identify a
 * call just as well but carries no ordering, which would leave that choice
 * arbitrary.
 */
const nextWriteGroup = createUlidFactory();

/**
 * Best-effort delete the offloaded objects of uploads this call's rows do not
 * reference, if an offloader is configured. A key the row that actually exists
 * still points at is held back: two calls writing the same value for one write
 * address one object, so the loser's "dead" upload can be the winner's live one
 * (see {@link releasableS3Keys}).
 */
async function cleanUpItems(context: CheckpointerContext, dead: DeadUpload[]): Promise<void> {
  if (!context.offloader) return;
  const keys = dead.flatMap(({ item, live }) => releasableS3Keys([item.value], live ? [live] : []));
  if (keys.length === 0) return;
  await cleanUpS3Orphans(context.offloader, keys, 'putWrites', context.logger);
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
 * {@link writeSpecialItemsWithCleanup}). Cleanup only ever targets uploads
 * confirmed unreferenced (see {@link writeRegularItems}): a verified
 * non-commit, or a guard rejection whose returned row provably belongs to
 * another call — and in both cases only when that row does not point at the
 * same object. A special write's superseded payload is released only when a
 * read of the row after the commit does not name it. An upload can leak. An
 * object is released only when the row last seen before the release does not
 * name it; S3 has no conditional delete, so a write of byte-identical content
 * that commits between that read and the delete can still lose its object, and
 * that gap is the one remaining window.
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
