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
      await compensate(context, sessionId, chunks, committed, toError(error as Error), fields.now);
    }
  }
}
