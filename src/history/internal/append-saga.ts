import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { ErrorCode } from '../../shared/errors/error-code';
import { toError } from '../../shared/errors/wrap-error';
import type { ChatMessageItem } from '../types';
import { type CommittedChunk, compensate } from './compensation';
import { writeMessageChunk } from './message-transaction';
import type { HistoryContext } from './setup';

/** Shared per-append metadata applied to every chunk's session update. */
export interface AppendFields {
  now: string;
  title?: string;
  ttlTimestamp?: number;
  forceTtlRefresh?: boolean;
}

/** What a post-failure read established about the chunk that just failed. */
type ChunkVerdict = 'committed' | 'not-committed' | 'unverified';

/** True for the one failure shape that leaves the outcome ambiguous. */
function isAmbiguous(error: Error): boolean {
  return (error as { code?: string }).code === ErrorCode.RETRY_EXHAUSTED;
}

/**
 * Read the chunk's first row back with `ConsistentRead`. A chunk commits
 * atomically, so one row present means the whole chunk (and its count `ADD`)
 * landed and only the response was lost. Message sort keys are per-call
 * ULIDs, so a present row can only be this call's own.
 */
async function verifyChunkLanded(
  context: HistoryContext,
  chunk: ChatMessageItem[],
): Promise<ChunkVerdict> {
  try {
    const result = await withDynamoDBRetry(
      () =>
        context.client.get({
          TableName: context.tableName,
          Key: { PK: chunk[0].PK, SK: chunk[0].SK },
          ConsistentRead: true,
          ProjectionExpression: '#sk',
          ExpressionAttributeNames: { '#sk': 'SK' },
        }),
      context.retry,
    );
    return result.Item ? 'committed' : 'not-committed';
  } catch {
    return 'unverified';
  }
}

/** Run one chunk's transaction, returning its error instead of throwing. */
async function commitChunk(
  context: HistoryContext,
  sessionId: string,
  chunk: ChatMessageItem[],
  fields: AppendFields,
  signal?: AbortSignal,
): Promise<Error | undefined> {
  try {
    await writeMessageChunk(
      context,
      chunk,
      { ...fields, sessionId, count: chunk.length },
      { signal },
    );
    return undefined;
  } catch (error) {
    return toError(error as Error);
  }
}

function asCommitted(chunk: ChatMessageItem[]): CommittedChunk {
  return { keys: chunk.map((item) => ({ PK: item.PK, SK: item.SK })), count: chunk.length };
}

/**
 * Append message chunks with caller-observed atomicity. Each chunk commits its
 * messages and count in one transaction; if a later chunk fails, every
 * already-committed chunk is deleted and its count reverted, and the batch's
 * S3 objects are cleaned once their rows are gone, restoring the pre-call
 * state before the error is rethrown. Except on a failed rollback, which
 * surfaces as {@link CompensationFailedError} and deliberately leaves the
 * committed chunks' S3 objects behind, since their rows may survive.
 *
 * A `RetryExhaustedError` is ambiguous — the transaction may have committed
 * and lost its response — so the chunk is read back first: present means it
 * committed (continue), absent means it did not (compensate), and a failed
 * read compensates but leaks that chunk's objects rather than delete objects
 * its possibly-live rows reference.
 */
export async function appendChunks(
  context: HistoryContext,
  sessionId: string,
  chunks: ChatMessageItem[][],
  fields: AppendFields,
  signal?: AbortSignal,
): Promise<void> {
  const committed: CommittedChunk[] = [];
  for (const chunk of chunks) {
    const failure = await commitChunk(context, sessionId, chunk, fields, signal);
    if (!failure) {
      committed.push(asCommitted(chunk));
      continue;
    }
    const verdict = isAmbiguous(failure)
      ? await verifyChunkLanded(context, chunk)
      : 'not-committed';
    if (verdict === 'committed') {
      committed.push(asCommitted(chunk));
      continue;
    }
    await compensate(
      context,
      sessionId,
      chunks,
      committed,
      failure,
      fields.now,
      fields.title,
      verdict === 'unverified',
    );
  }
}
