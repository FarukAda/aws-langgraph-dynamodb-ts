import { verifyRow, type WriteVerdict } from '../../shared/dynamodb/write-verify';
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

/** True for the one failure shape that leaves the outcome ambiguous. */
function isAmbiguous(error: Error): boolean {
  return (error as { code?: string }).code === ErrorCode.RETRY_EXHAUSTED;
}

/**
 * Read the chunk's first row back. A chunk commits atomically, so one row
 * present means the whole chunk (and its count `ADD`) landed and only the
 * response was lost.
 *
 * The row's own sort key is what identifies it: message sort keys are per-call
 * ULIDs, so a row at that key can only be this call's own, and its presence is
 * the whole question.
 */
async function verifyChunkLanded(
  context: HistoryContext,
  chunk: ChatMessageItem[],
): Promise<WriteVerdict> {
  const { verdict } = await verifyRow(context, {
    key: { PK: chunk[0].PK, SK: chunk[0].SK },
    kind: 'attribute',
    attribute: 'SK',
    expected: chunk[0].SK,
  });
  return verdict;
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
 *
 * Accepts: `chunks` — in order, each already within the transaction's limits;
 * no chunks is no work and no write. `fields` — the session update every chunk
 * carries. `signal` — aborts between chunks.
 *
 * Returns: nothing, and only when every chunk is known to have committed.
 *
 * Throws: the first chunk's failure, after the rollback has restored the
 * pre-call state; or {@link CompensationFailedError} carrying both that failure
 * and the rollback's own, when the rollback could not finish.
 *
 * Guarantees: each message's S3 key carries its own ULID, so no two rows of any
 * call can address the same object and the rollback's cleanup can never delete
 * an object a surviving row still points at. What a caller observes is
 * all-or-nothing; what the table holds is all-or-nothing only until a rollback
 * fails, which is why that case is a distinct error and not a rethrow.
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
    const verdict: WriteVerdict = isAmbiguous(failure)
      ? await verifyChunkLanded(context, chunk)
      : 'not-landed';
    if (verdict === 'landed') {
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
