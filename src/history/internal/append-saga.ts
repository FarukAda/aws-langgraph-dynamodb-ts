import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { batchWriteAll } from '../../shared/dynamodb/batch-write';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { ChatMessageItem } from '../types';
import { SESSION_SORT_KEY, sessionPartition } from './keys';
import { writeMessageChunk } from './message-transaction';
import type { HistoryContext } from './setup';

/** Shared per-append metadata applied to every chunk's session update. */
export interface AppendFields {
  now: string;
  title?: string;
  ttlTimestamp?: number;
}

/** A chunk that committed, retained so it can be rolled back on a later failure. */
interface CommittedChunk {
  keys: { PK: string; SK: string }[];
  count: number;
}

/** Subtract a previously-added count from the session, leaving it consistent. */
async function revertSessionCount(
  context: HistoryContext,
  sessionId: string,
  delta: number,
): Promise<void> {
  if (delta === 0) return;
  await withDynamoDBRetry(() =>
    context.client.update({
      TableName: context.tableName,
      Key: { PK: sessionPartition(sessionId), SK: SESSION_SORT_KEY },
      UpdateExpression: 'ADD #count :neg',
      ExpressionAttributeNames: { '#count': 'messageCount' },
      ExpressionAttributeValues: { ':neg': -delta },
    }),
  );
}

/** Best-effort delete every offloaded S3 object uploaded for the whole batch. */
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
 * Append message chunks with caller-observed atomicity. Each chunk commits its
 * messages and count in one transaction; if a later chunk fails, every
 * already-committed chunk is deleted and its count reverted, and all batch S3
 * objects are cleaned, restoring the pre-call state before the error is
 * rethrown. So `addMessages` either lands the whole batch or nothing.
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
        sessionId,
        count: chunk.length,
        now: fields.now,
        title: fields.title,
        ttlTimestamp: fields.ttlTimestamp,
      });
      committed.push({
        keys: chunk.map((item) => ({ PK: item.PK, SK: item.SK })),
        count: chunk.length,
      });
    } catch (error) {
      await cleanBatchS3(context, chunks);
      await rollbackCommitted(context, sessionId, committed);
      throw error;
    }
  }
}
