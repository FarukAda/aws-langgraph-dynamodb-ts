/**
 * Hides how an append of any size commits all-or-nothing, as its caller sees it.
 *
 * One `TransactWriteItems` carries at most a hundred items and four megabytes,
 * so a large append is several transactions, each writing its messages and the
 * SESSION row's update together. When one of them fails the append is rolled
 * back: committed chunks are deleted and their effect on the SESSION row
 * reverted, and each S3 object is released only once no row can name it. An
 * ambiguous failure is read back before anything is undone. This is also the
 * one module that writes a message row, which is what lets a delete pin a
 * message row to the SESSION row's `writeId`.
 */

import { nowIso } from '../../shared/clock';
import { PayloadLocation, type PayloadDescriptor, collectS3Keys } from '../../shared/codec/codec';
import { cleanUpS3Orphans } from '../../shared/codec/s3/offloader';
import { batchWriteAll } from '../../shared/dynamodb/batch-write';
import { conditionFailedAt, conditionalCheckFailure } from '../../shared/dynamodb/cancellation';
import {
  transactIdempotently,
  verifyRow,
  type WriteVerdict,
} from '../../shared/dynamodb/idempotent-write';
import { type RowKey, SORT_KEY_ATTRIBUTE, rowKeyOf } from '../../shared/dynamodb/table-schema';
import { DynamoDBLangGraphError, hasErrorCode, toError } from '../../shared/errors/base-error';
import { ErrorCode } from '../../shared/errors/error-code';
import { compensationFailedError } from '../../shared/errors/errors';
import { absorbLoggerFailure } from '../../shared/logging/logger';
import type { SessionId, StorableMessages } from './parse';
import { buildMessageItem, type ChatMessageItem } from './rows';
import {
  buildSessionUpdateItem,
  deriveTitle,
  revertSessionCount,
  revertSessionCreation,
  type SessionUpdateFields,
  type TtlAnchorResult,
} from './session';
import { type HistoryContext, MESSAGE_APPEND_RETRY_MAX_ATTEMPTS } from './setup';

/** One append, parsed: the session, its messages in stored form, and the session's ttl anchor. */
export interface AppendRequest {
  readonly sessionId: SessionId;
  readonly messages: StorableMessages;
  /** The session's creation-anchored ttl, when the adapter has a ttl. */
  readonly anchor: TtlAnchorResult | undefined;
  readonly signal?: AbortSignal;
}

/** Shared per-append metadata applied to every chunk's session update. */
interface AppendFields {
  now: string;
  title?: string;
  ttlTimestamp?: number;
  forceTtlRefresh?: boolean;
}

/** An append cut into chunks, with the fields every chunk's SESSION update stamps. */
export interface ChunkedAppend {
  readonly sessionId: SessionId;
  readonly chunks: ChatMessageItem[][];
  readonly fields: AppendFields;
  readonly signal?: AbortSignal;
}

/** A chunk that committed, retained so it can be rolled back on a later failure. */
interface CommittedChunk {
  keys: RowKey[];
  count: number;
}

/** How far a failed append got, which decides what its rollback undoes. */
export interface FailedAppend {
  readonly committed: CommittedChunk[];
  readonly trigger: Error;
  /** True when the failing chunk's own outcome could not be read back. */
  readonly uncertain: boolean;
}

/** Message Puts per append transaction: the 100-item limit, less the metadata Update. */
const MAX_MESSAGES_PER_TRANSACTION = 99;

/**
 * Aggregate byte budget per transaction. Held ~500 KB below DynamoDB's 4 MB
 * `TransactWriteItems` ceiling so the conservative per-item estimate (see
 * `ITEM_OVERHEAD_BYTES`) cannot push a chunk over the real limit at commit time.
 */
const MAX_TRANSACTION_BYTES = 3_500_000;

/**
 * Encode every message, cleaning up after itself if one fails partway.
 *
 * Offloaded messages upload sequentially here, *before* the append saga's
 * compensation machinery is ever reached, so a failure on message N used to
 * strand messages 1..N-1's already-uploaded S3 objects with no cleanup path —
 * the one gap in this subsystem's otherwise complete no-orphan guarantee.
 * Nothing will ever reference those objects, so they are safe to delete
 * unconditionally on the way out.
 */
async function buildItems(
  context: HistoryContext,
  request: AppendRequest,
): Promise<ChatMessageItem[]> {
  const { sessionId, signal } = request;
  const ttlTimestamp = request.anchor?.ttlTimestamp;
  const items: ChatMessageItem[] = [];
  try {
    for (const message of request.messages) {
      items.push(
        await buildMessageItem(
          context,
          { sessionId, messageId: context.ulid(), message, ttlTimestamp },
          signal,
        ),
      );
    }
  } catch (error) {
    if (context.offloader) {
      await cleanUpS3Orphans(context.offloader, {
        keys: collectS3Keys(items.map((item) => item.message)),
        operation: 'history.addMessages.encode',
        logger: context.logger,
      });
    }
    throw error;
  }
  return items;
}

/**
 * Append messages to a session: encode them, cut them into transactions, and
 * commit them all or undo what committed.
 *
 * Accepts: `request` — the parsed session and messages, the ttl anchor, and
 * the caller's signal.
 *
 * Returns: nothing, once every chunk has committed.
 *
 * Throws: the first chunk's failure after the append is rolled back;
 * `COMPENSATION_FAILED` when the rollback itself fails; whatever encoding a
 * message throws, after this call's own uploads are released.
 */
export async function appendMessages(
  context: HistoryContext,
  request: AppendRequest,
): Promise<void> {
  const items = await buildItems(context, request);
  const chunks = chunkBySize(items, MAX_MESSAGES_PER_TRANSACTION, MAX_TRANSACTION_BYTES);
  await appendChunks(context, {
    sessionId: request.sessionId,
    chunks,
    fields: {
      now: nowIso(),
      title: deriveTitle(request.messages),
      ttlTimestamp: request.anchor?.ttlTimestamp,
      forceTtlRefresh: request.anchor?.refresh,
    },
    signal: request.signal,
  });
}

/**
 * Say what the compensation is doing, and make sure the saying cannot stop it.
 *
 * The caller's `Logger` is consumer code, and both lines here are written from
 * inside a rollback: the first is {@link compensate}'s opening statement, the
 * second sits in the `catch` that builds `COMPENSATION_FAILED`. A
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
  { sessionId, committedChunks }: { sessionId: SessionId; committedChunks: number },
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
  await cleanUpS3Orphans(context.offloader, {
    keys: collectS3Keys(descriptors),
    operation: 'history.addMessages',
    logger: context.logger,
  });
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
  append: ChunkedAppend,
  committed: CommittedChunk[],
): Promise<void> {
  const { sessionId } = append;
  const { now, title } = append.fields;
  const keys = committed.flatMap((chunk) => chunk.keys);
  const total = committed.reduce((sum, chunk) => sum + chunk.count, 0);
  if (keys.length === 0) {
    await revertSessionCreation(context, sessionId, { total, createdAt: now, title });
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
  await revertSessionCreation(context, sessionId, { total, createdAt: now, title });
}

/**
 * Undo a failed batch. Always throws. S3 cleanup is split by commit status so
 * no live row is ever left pointing at a deleted object: the never-committed
 * suffix is cleaned immediately, the committed prefix only after its rows are
 * confirmed deleted. If the rollback itself fails, the committed chunks' S3
 * objects are deliberately left in place (their rows may survive) and it
 * raises `COMPENSATION_FAILED` carrying both the trigger and the
 * rollback error; otherwise it rethrows the trigger.
 *
 * `failure.uncertain` marks the failed chunk
 * (`append.chunks[failure.committed.length]`) as one whose outcome could not be
 * verified: its rows may be live, so its objects are leaked rather than
 * deleted, while the never-attempted chunks after it are still cleaned.
 *
 * Accepts: `append` — the append that failed: its `sessionId`, its `chunks` in
 * order, and the `fields.now` and `fields.title` its first chunk stamped on
 * the session row. `failure.committed` — the chunks known to have landed, in
 * order; empty means the very first chunk failed, and then the only thing to
 * undo is the session row this call may have created. `failure.trigger` — the
 * failure that started this. `failure.uncertain` — see above.
 *
 * Returns: never; the declared `Promise<never>` is the contract.
 *
 * Throws: `failure.trigger` when the rollback succeeded, `COMPENSATION_FAILED`
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
  append: ChunkedAppend,
  failure: FailedAppend,
): Promise<never> {
  const { sessionId, chunks } = append;
  const { committed, trigger, uncertain } = failure;
  if (committed.length > 0) {
    reportStep(
      context,
      'warn',
      'history.addMessages compensating committed chunks after a chunk failed',
      { sessionId, committedChunks: committed.length },
    );
  }
  /**
   * The never-attempted suffix never had a DynamoDB row, so it is safe to
   * clean now; an uncertain failed chunk is skipped because its rows may live.
   */
  const firstDead = committed.length + (uncertain ? 1 : 0);
  await cleanBatchS3(context, chunks.slice(firstDead));
  try {
    await rollbackCommitted(context, append, committed);
  } catch (rollbackError) {
    reportStep(
      context,
      'error',
      'history.addMessages rollback failed; messageCount may have drifted',
      { sessionId, committedChunks: committed.length },
    );
    /** Skip S3 cleanup here: rollback may have failed, so committed rows might still reference these objects. */
    throw compensationFailedError(trigger, toError(rollbackError as Error));
  }
  /** Only now that committed rows are confirmed deleted is it safe to delete their S3 objects. */
  await cleanBatchS3(context, chunks.slice(0, committed.length));
  throw trigger;
}

/** True for the one failure shape that leaves the outcome ambiguous. */
function isAmbiguous(error: Error): boolean {
  return hasErrorCode(error, ErrorCode.RETRY_EXHAUSTED);
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
    key: rowKeyOf(chunk[0]),
    kind: 'attribute',
    attribute: SORT_KEY_ATTRIBUTE,
    expected: chunk[0].SK,
  });
  return verdict;
}

/** Run one chunk's transaction, returning its error instead of throwing. */
async function commitChunk(
  context: HistoryContext,
  append: ChunkedAppend,
  chunk: ChatMessageItem[],
): Promise<Error | undefined> {
  try {
    await writeMessageChunk(
      context,
      chunk,
      { ...append.fields, sessionId: append.sessionId, count: chunk.length },
      { signal: append.signal },
    );
    return undefined;
  } catch (error) {
    return toError(error as Error);
  }
}

function asCommitted(chunk: ChatMessageItem[]): CommittedChunk {
  return { keys: chunk.map((item) => rowKeyOf(item)), count: chunk.length };
}

/**
 * Append message chunks with caller-observed atomicity. Each chunk commits its
 * messages and count in one transaction; if a later chunk fails, every
 * already-committed chunk is deleted and its count reverted, and the batch's
 * S3 objects are cleaned once their rows are gone, restoring the pre-call
 * state before the error is rethrown. Except on a failed rollback, which
 * surfaces as `COMPENSATION_FAILED` and deliberately leaves the
 * committed chunks' S3 objects behind, since their rows may survive.
 *
 * A `RETRY_EXHAUSTED` error is ambiguous — the transaction may have committed
 * and lost its response — so the chunk is read back first: present means it
 * committed (continue), absent means it did not (compensate), and a failed
 * read compensates but leaks that chunk's objects rather than delete objects
 * its possibly-live rows reference.
 *
 * Accepts: `append.sessionId` — the session every chunk writes to.
 * `append.chunks` — in order, each already within the transaction's limits;
 * no chunks is no work and no write. `append.fields` — the session update every
 * chunk carries. `append.signal` — aborts between chunks.
 *
 * Returns: nothing, and only when every chunk is known to have committed.
 *
 * Throws: the first chunk's failure, after the rollback has restored the
 * pre-call state; or `COMPENSATION_FAILED` carrying both that failure
 * and the rollback's own, when the rollback could not finish.
 *
 * Guarantees: each message's S3 key carries its own ULID, so no two rows of any
 * call can address the same object and the rollback's cleanup can never delete
 * an object a surviving row still points at. What a caller observes is
 * all-or-nothing; what the table holds is all-or-nothing only until a rollback
 * fails, which is why that case is a distinct error and not a rethrow.
 */
export async function appendChunks(context: HistoryContext, append: ChunkedAppend): Promise<void> {
  const committed: CommittedChunk[] = [];
  for (const chunk of append.chunks) {
    const failure = await commitChunk(context, append, chunk);
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
    await compensate(context, append, {
      committed,
      trigger: failure,
      uncertain: verdict === 'unverified',
    });
  }
}

/** Per-call retry seams (injected in tests to keep backoff instant). */
export interface ChunkRetryOptions {
  rng?: () => number;
  signal?: AbortSignal;
}

/** True when a TransactWriteItems cancellation was caused solely by the SESSION update's ttl condition (always TransactItems index 0 — see attempt below), not by any message item. */
function isTtlConditionLoss(error: Error): boolean {
  return conditionFailedAt(error, 0) && conditionalCheckFailure(error) !== undefined;
}

/**
 * One send of the chunk, drawing the token that makes its re-sends safe.
 *
 * The message rows are keyed by their own ULIDs, so putting one twice changes
 * nothing; the session update is `ADD #count :n`, and that is the whole of the
 * damage a re-send would do. Applied rather than deduplicated it adds the
 * chunk's count a second time to a row whose messages are already there,
 * nothing on this path reads the count back to notice, and
 * `reconcileMessageCount` is the only repair.
 *
 * Drawn per send rather than per call, because the second send the ttl race
 * triggers is a *different* request: it repeats the same chunk with
 * `forceTtlRefresh: false`, which drops the session update's
 * ConditionExpression, and the same token presented with changed parameters
 * inside the service's window is refused outright. That race is also the one
 * place the precondition on what a token guarantees shows here — the first
 * send was cancelled by its condition, so it committed nothing, nothing was
 * cached for its token, and the second send is a fresh evaluation rather than
 * a replay. The deadline drawn beside the token is what keeps each send's
 * retrying inside the window that send's token is honoured for; the token
 * enforces no window of its own.
 *
 * What each call passes. The deadline is minted here, beside the token,
 * rather than once per `writeMessageChunk`. The ttl race sends the chunk twice
 * and each send draws its own token, so each send is honoured for its own ten
 * minutes and is entitled to a full budget. One deadline per call would hand
 * the second send whatever the first did not spend, silently halving the
 * retrying that matters most — the send made after a race has already been
 * lost. That deadline is a bound on the whole budget, never on the attempt
 * count. `minAttempts` is the contention floor: a caller policy may raise the
 * budget, never lower it. `retry.signal` aborts between attempts, and reaches
 * the SDK request in flight as its `abortSignal`, so an attempt under way is
 * cancelled rather than merely awaited; `retry.rng` replaces the backoff's
 * jitter source.
 */
async function attempt(
  context: HistoryContext,
  items: ChatMessageItem[],
  fields: SessionUpdateFields,
  retry: ChunkRetryOptions,
): Promise<void> {
  await transactIdempotently(
    context,
    [
      buildSessionUpdateItem(context.tableName, fields),
      ...items.map((item) => ({ Put: { TableName: context.tableName, Item: item } })),
    ],
    { signal: retry.signal, rng: retry.rng, minAttempts: MESSAGE_APPEND_RETRY_MAX_ATTEMPTS },
  );
}

/**
 * Atomically write a chunk of message items together with the session-metadata
 * count update in one {@link https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html | TransactWriteItems}
 * call, so `messageCount` can never disagree with the messages that landed. A
 * single `ClientRequestToken` is used per attempt so a re-sent commit (e.g.
 * after a lost response) is idempotent and never double-applies the count
 * `ADD`. When `fields.forceTtlRefresh` is set, the session update carries a
 * monotonic ConditionExpression (see session.ts); if — and only if —
 * that specific condition loses a race against a concurrent caller who just
 * healed the same anchor, this retries the identical chunk once with
 * `forceTtlRefresh: false` (safe: `if_not_exists` then converges to whatever
 * already won) rather than losing the message writes to a benign ttl race. A
 * cancellation caused by any other item (a genuine message-row conflict) is
 * not retried here — it propagates for the normal transient-conflict retry
 * budget inside `withDynamoDBRetry` to handle, or to the caller otherwise.
 *
 * Accepts: `items` — one chunk, already within the transaction's limits.
 * `fields` — the session-metadata update accompanying it; its `indexShards` and
 * its `writeId` are taken from the adapter's context, never from the caller.
 * `retry.signal` — aborts between attempts.
 *
 * Returns: nothing. The chunk and the count are committed together or not at
 * all.
 *
 * Throws: whatever the transaction throws — including a
 * `TransactionCanceledException` for a genuine conflict, after the retry budget
 * is spent. The caller compensates; this function never partially succeeds.
 *
 * Guarantees: `messageCount` can never disagree with the messages that landed,
 * because they land in one transaction. At most one extra attempt is spent on
 * the benign ttl race, and it carries its own request token, so a retry can
 * never double-apply the count — and its own deadline of
 * `MAX_WRITE_LIFETIME_MS`, so the retrying stops while that token is
 * still deduplicating rather than after it has expired. The SESSION row's
 * `writeId` moves if and only if a message row was added: the update travels in
 * the same transaction as the rows, and nothing else writes it.
 */
export async function writeMessageChunk(
  context: HistoryContext,
  items: ChatMessageItem[],
  fields: Omit<SessionUpdateFields, 'writeId'>,
  retry: ChunkRetryOptions = {},
): Promise<void> {
  /**
   * The index shard comes from the adapter's context, not from the caller's
   * fields, and the write id is drawn here — once per chunk, beside it. Drawn
   * here rather than inside the builder, every attempt of this chunk carries
   * one id, and no caller can supply or reuse one.
   */
  const withIndex = { ...fields, indexShards: context.indexShards, writeId: context.ulid() };
  try {
    await attempt(context, items, withIndex, retry);
  } catch (error) {
    if (fields.forceTtlRefresh && isTtlConditionLoss(error as Error)) {
      await attempt(context, items, { ...withIndex, forceTtlRefresh: false }, retry);
      return;
    }
    throw error;
  }
}

/**
 * Per-item allowance added to the measured field bytes to cover what the size
 * estimate does not count directly: DynamoDB attribute names, the document
 * marshalling envelope, and descriptor scaffolding. Deliberately generous so the
 * estimate stays at or above the real marshalled item size and chunks never
 * overshoot the transaction byte limit.
 */
const ITEM_OVERHEAD_BYTES = 256;

/**
 * Byte length of a string as DynamoDB stores it. `String.length` counts UTF-16
 * code units, which understates every non-ASCII character — the wrong
 * direction for an estimate documented to sit at or above the real size.
 */
function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function descriptorBytes(descriptor: PayloadDescriptor): number {
  const body =
    descriptor.location === PayloadLocation.INLINE
      ? descriptor.bytes.length
      : utf8Bytes(descriptor.s3Key);
  return body + utf8Bytes(descriptor.serdeType);
}

/**
 * Conservatively estimate a message item's stored size.
 *
 * Accepts: any message item, inline or offloaded — an offloaded one measures
 * its S3 key, since that is what the row actually carries.
 *
 * Returns: an estimate at or above the real marshalled size. Erring high is the
 * whole point: an underestimate builds a transaction DynamoDB refuses, and the
 * cost of erring high is one extra transaction.
 *
 * Throws: nothing.
 */
export function estimateItemBytes(item: ChatMessageItem): number {
  return (
    utf8Bytes(item.PK) +
    utf8Bytes(item.SK) +
    utf8Bytes(item.sessionId) +
    descriptorBytes(item.message) +
    ITEM_OVERHEAD_BYTES
  );
}

function shouldFlush(
  chunk: { count: number; bytes: number },
  next: number,
  limits: { maxItems: number; maxBytes: number },
): boolean {
  if (chunk.count === 0) return false;
  return chunk.count >= limits.maxItems || chunk.bytes + next > limits.maxBytes;
}

/**
 * Split message items into transaction-sized chunks.
 *
 * Accepts: `items` — in order; empty yields no chunks, so an append of nothing
 * issues no write. `maxItems` and `maxBytes` — the transaction's two limits,
 * both binding.
 *
 * Returns: the chunks, in order, each within both limits — except that a single
 * item larger than `maxBytes` is placed alone rather than dropped: refusing it
 * here would lose a message that DynamoDB might still accept, and if it does
 * not, the transaction says so.
 *
 * Throws: nothing.
 *
 * Guarantees: order is preserved across chunks, so messages keep the order the
 * caller wrote them in, which is the order their ULIDs already encode.
 */
export function chunkBySize(
  items: ChatMessageItem[],
  maxItems: number,
  maxBytes: number,
): ChatMessageItem[][] {
  const chunks: ChatMessageItem[][] = [];
  let current: ChatMessageItem[] = [];
  let currentBytes = 0;
  for (const item of items) {
    const size = estimateItemBytes(item);
    if (shouldFlush({ count: current.length, bytes: currentBytes }, size, { maxItems, maxBytes })) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
