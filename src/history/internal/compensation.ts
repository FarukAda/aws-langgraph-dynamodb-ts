import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { batchWriteAll } from '../../shared/dynamodb/batch-write';
import {
  type BatchWriteAllIncompleteError,
  CompensationFailedError,
} from '../../shared/errors/errors';
import { toError } from '../../shared/errors/wrap-error';
import type { ChatMessageItem } from '../types';
import { revertSessionCount, revertSessionCreation } from './session-count';
import type { HistoryContext } from './setup';

/** A chunk that committed, retained so it can be rolled back on a later failure. */
export interface CommittedChunk {
  keys: { PK: string; SK: string }[];
  count: number;
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
    );
  } catch (error) {
    /**
     * batchWriteAll has exactly one throw site and it is always a
     * BatchWriteAllIncompleteError (see Task 9) — asserted, not instanceof-
     * checked, since the false case is unreachable and this project
     * enforces 100% branch coverage with no exceptions.
     */
    const deleted = (error as BatchWriteAllIncompleteError).succeededCount;
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
    context.logger.warn('history.addMessages compensating committed chunks after a chunk failed', {
      sessionId,
      committedChunks: committed.length,
    });
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
    context.logger.error('history.addMessages rollback failed; messageCount may have drifted', {
      sessionId,
      committedChunks: committed.length,
    });
    /** Skip S3 cleanup here: rollback may have failed, so committed rows might still reference these objects. */
    throw new CompensationFailedError(trigger, toError(rollbackError as Error));
  }
  /** Only now that committed rows are confirmed deleted is it safe to delete their S3 objects. */
  await cleanBatchS3(context, chunks.slice(0, committed.length));
  throw trigger;
}
