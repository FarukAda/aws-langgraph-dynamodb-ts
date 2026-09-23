import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { batchWriteAll } from '../../shared/dynamodb/batch-write';
import { DynamoDBLangGraphError } from '../../shared/errors/base-error';
import { ErrorCode } from '../../shared/errors/error-code';
import { CompensationFailedError } from '../../shared/errors/errors';
import { toError } from '../../shared/errors/wrap-error';
import { absorbLoggerFailure } from '../../shared/logging/logger';
import type { ChatMessageItem } from '../types';
import { revertSessionCount, revertSessionCreation } from './session-count';
import type { HistoryContext } from './setup';

/** A chunk that committed, retained so it can be rolled back on a later failure. */
export interface CommittedChunk {
  keys: { PK: string; SK: string }[];
  count: number;
}

/**
 * Say what the compensation is doing, and make sure the saying cannot stop it.
 *
 * The caller's `Logger` is consumer code, and both lines here are written from
 * inside a rollback: the first is {@link compensate}'s opening statement, the
 * second sits in the `catch` that builds {@link CompensationFailedError}. A
 * throw out of either used to take the rollback with it — the first skipping
 * the S3 cleanup, every committed chunk's deletes, the count revert and the
 * rethrow in one go; the second replacing the one error whose job is to say
 * that `messageCount` drifted.
 *
 * The guard itself is {@link absorbLoggerFailure}, which this held an inline
 * copy of while that helper belonged to another change. Swallowing is still
 * the answer for the reason it gives: the only channel a report could use is
 * the one that just broke. Guarded here rather than left to the seam the
 * context's logger was resolved at, because this is the package's least
 * forgiving path — it runs once per rolled-back append, and what it loses if
 * it stops early is a caller's "all messages or none".
 */
function reportStep(
  context: HistoryContext,
  level: 'warn' | 'error',
  message: string,
  sessionId: string,
  committedChunks: number,
): void {
  absorbLoggerFailure(() => context.logger[level](message, { sessionId, committedChunks }));
}

/**
 * Best-effort delete the offloaded S3 objects of the `chunks` slice given.
 * {@link compensate} calls it once per commit status, never for the whole
 * batch, so a committed chunk's objects arrive only once its rows are gone.
 */
async function cleanBatchS3(context: HistoryContext, chunks: ChatMessageItem[][]): Promise<void> {
  if (!context.offloader) return;
  const descriptors = chunks.flat().map((item) => item.message);
  await cleanUpS3Orphans(
    context.offloader,
    collectS3Keys(descriptors),
    'history.addMessages',
    context.logger,
  );
}

/**
 * Delete every committed chunk's items, then undo their effect on the session
 * row — deleting it outright when this call created it (see
 * {@link revertSessionCreation}), so a failed first append leaves no ghost
 * session holding the rolled-back message's title. A *partial* delete is not a
 * clean creation to undo, so that branch reverts only the count.
 */
async function rollbackCommitted(
  context: HistoryContext,
  sessionId: string,
  committed: CommittedChunk[],
  now: string,
  title: string | undefined,
): Promise<void> {
  const keys = committed.flatMap((chunk) => chunk.keys);
  const total = committed.reduce((sum, chunk) => sum + chunk.count, 0);
  if (keys.length === 0) {
    await revertSessionCreation(context, sessionId, total, now, title);
    return;
  }
  try {
    await batchWriteAll(
      context.client,
      context.tableName,
      keys.map((Key) => ({ DeleteRequest: { Key } })),
      { retry: context.retry },
    );
  } catch (error) {
    /**
     * `batchWriteAll` raises `BATCH_WRITE_INCOMPLETE` for every failure but a
     * cancel, and this call passes no signal, so the cancel cannot arise here
     * — asserted rather than narrowed, since the false branch is unreachable
     * and this project enforces 100% branch coverage. A signal reaching this
     * call would have to narrow instead.
     */
    const deleted = (error as DynamoDBLangGraphError<ErrorCode.BATCH_WRITE_INCOMPLETE>).details
      .succeededCount;
    await revertSessionCount(context, sessionId, deleted, now);
    throw error;
  }
  await revertSessionCreation(context, sessionId, total, now, title);
}

/**
 * Undo a failed batch. Always throws. S3 cleanup is split by commit status so
 * no live row is ever left pointing at a deleted object: the never-committed
 * suffix is cleaned immediately, the committed prefix only after its rows are
 * confirmed deleted. If the rollback itself fails, the committed chunks' S3
 * objects are deliberately left in place (their rows may survive) and it
 * raises {@link CompensationFailedError} carrying both the trigger and the
 * rollback error; otherwise it rethrows the trigger.
 *
 * `uncertain` marks the failed chunk (`chunks[committed.length]`) as one whose
 * outcome could not be verified: its rows may be live, so its objects are
 * leaked rather than deleted, while the never-attempted chunks after it are
 * still cleaned.
 *
 * Accepts: `committed` — the chunks known to have landed, in order; empty means
 * the very first chunk failed, and then the only thing to undo is the session
 * row this call may have created. `trigger` — the failure that started this.
 * `uncertain` — see above.
 *
 * Returns: never; the declared `Promise<never>` is the contract.
 *
 * Throws: `trigger` when the rollback succeeded, {@link CompensationFailedError}
 * when it did not.
 *
 * Guarantees: an object is deleted only once no row can reference it — the
 * never-committed suffix immediately, the committed prefix only after its rows
 * are confirmed gone, and an unverified chunk never. Storage is leaked in
 * preference to leaving a live row pointing at a deleted object.
 *
 * Neither of its two log lines can stop it: both go through
 * {@link reportStep}. A throw from the first used to skip the S3 cleanup, the
 * rollback, the count revert and the rethrow all at once, leaving every
 * committed chunk in the table with `messageCount` still counting it, and
 * handing the caller the logger's own error in place of the failure that
 * started this. Announcing the rollback is not the rollback.
 */
export async function compensate(
  context: HistoryContext,
  sessionId: string,
  chunks: ChatMessageItem[][],
  committed: CommittedChunk[],
  trigger: Error,
  now: string,
  title: string | undefined,
  uncertain: boolean,
): Promise<never> {
  if (committed.length > 0) {
    reportStep(
      context,
      'warn',
      'history.addMessages compensating committed chunks after a chunk failed',
      sessionId,
      committed.length,
    );
  }
  /**
   * The never-attempted suffix never had a DynamoDB row, so it is safe to
   * clean now; an uncertain failed chunk is skipped because its rows may live.
   */
  const firstDead = committed.length + (uncertain ? 1 : 0);
  await cleanBatchS3(context, chunks.slice(firstDead));
  try {
    await rollbackCommitted(context, sessionId, committed, now, title);
  } catch (rollbackError) {
    reportStep(
      context,
      'error',
      'history.addMessages rollback failed; messageCount may have drifted',
      sessionId,
      committed.length,
    );
    /** Skip S3 cleanup here: rollback may have failed, so committed rows might still reference these objects. */
    throw new CompensationFailedError(trigger, toError(rollbackError as Error));
  }
  /** Only now that committed rows are confirmed deleted is it safe to delete their S3 objects. */
  await cleanBatchS3(context, chunks.slice(0, committed.length));
  throw trigger;
}
