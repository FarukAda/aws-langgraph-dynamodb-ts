import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { batchWriteAll } from '../../shared/dynamodb/batch-write';
import { CompensationFailedError } from '../../shared/errors/errors';
import { toError } from '../../shared/errors/wrap-error';
import type { ChatMessageItem } from '../types';
import { writeMessageChunk } from './message-transaction';
import { revertSessionCount } from './session-count';
import type { HistoryContext } from './setup';

/** Shared per-append metadata applied to every chunk's session update. */
export interface AppendFields {
  now: string;
  title?: string;
  ttlTimestamp?: number;
  forceTtlRefresh?: boolean;
}

/** A chunk that committed, retained so it can be rolled back on a later failure. */
interface CommittedChunk {
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

/** Delete every committed chunk's items and revert their counted total. */
async function rollbackCommitted(
  context: HistoryContext,
  sessionId: string,
  committed: CommittedChunk[],
): Promise<void> {
  const keys = committed.flatMap((chunk) => chunk.keys);
  if (keys.length > 0) {
    await batchWriteAll(
      context.client,
      context.tableName,
      keys.map((Key) => ({ DeleteRequest: { Key } })),
    );
  }
  const total = committed.reduce((sum, chunk) => sum + chunk.count, 0);
  await revertSessionCount(context, sessionId, total);
}

/**
 * Undo a failed batch. Always throws. S3 cleanup is split by commit status so
 * no live row is ever left pointing at a deleted object: the never-committed
 * suffix is cleaned immediately, the committed prefix only after its rows are
 * confirmed deleted. If the rollback itself fails, the committed chunks' S3
 * objects are deliberately left in place (their rows may survive) and it
 * raises {@link CompensationFailedError} carrying both the trigger and the
 * rollback error; otherwise it rethrows the trigger.
 */
async function compensate(
  context: HistoryContext,
  sessionId: string,
  chunks: ChatMessageItem[][],
  committed: CommittedChunk[],
  trigger: Error,
): Promise<never> {
  if (committed.length > 0) {
    context.logger.warn('history.addMessages compensating committed chunks after a chunk failed', {
      sessionId,
      committedChunks: committed.length,
    });
  }
  /** The failed/never-attempted suffix never had a DynamoDB row, so it's safe to clean now. */
  await cleanBatchS3(context, chunks.slice(committed.length));
  try {
    await rollbackCommitted(context, sessionId, committed);
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

/**
 * Append message chunks with caller-observed atomicity. Each chunk commits its
 * messages and count in one transaction; if a later chunk fails, every
 * already-committed chunk is deleted and its count reverted, and the batch's
 * S3 objects are cleaned once their rows are gone, restoring the pre-call
 * state before the error is rethrown. Except on a failed rollback, which
 * surfaces as {@link CompensationFailedError} and deliberately leaves the
 * committed chunks' S3 objects behind, since their rows may survive.
 */
export async function appendChunks(
  context: HistoryContext,
  sessionId: string,
  chunks: ChatMessageItem[][],
  fields: AppendFields,
): Promise<void> {
  const committed: CommittedChunk[] = [];
  for (const chunk of chunks) {
    try {
      await writeMessageChunk(context, chunk, {
        ...fields,
        sessionId,
        count: chunk.length,
      });
      committed.push({
        keys: chunk.map((item) => ({ PK: item.PK, SK: item.SK })),
        count: chunk.length,
      });
    } catch (error) {
      await compensate(context, sessionId, chunks, committed, toError(error as Error));
    }
  }
}
