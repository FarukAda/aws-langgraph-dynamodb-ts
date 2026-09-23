import {
  isConditionalCheckFailed,
  OVERWRITE_CAS_MAX_ATTEMPTS,
  type RevisionGuard,
  revisionGuard,
} from '../../shared/dynamodb/conditional-put';
import { putIdempotently, referencesS3Object } from '../../shared/dynamodb/idempotent-write';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { type CheckpointWriteItem, WRITE_GROUP_ATTRIBUTE } from './rows';
import type { CheckpointerContext } from './setup';
import {
  readSpecialRow,
  type SpecialRowState,
  type SpecialWriteOutcome,
  verifyAfterFailure,
} from './special-write-verify';

/** Outcome of {@link attemptCasWrites}: either a settled write, or every attempt rejected. */
type CasAttemptResult =
  { done: true; outcome: SpecialWriteOutcome } | { done: false; observed: SpecialRowState };

/**
 * Commit one special row, optionally pinned to the `writeGroup` the caller
 * observed.
 *
 * The write takes one of two shapes, and which one is decided by the
 * **descriptor** rather than by the adapter. An item whose payload was
 * offloaded goes out as a one-item `TransactWriteItems` under a client request
 * token, so a re-send of a write the service already applied is discarded
 * instead of landing a second time — which, after a concurrent call has
 * released that row's object, would leave a live row naming nothing. An item
 * whose payload is inline goes out as the plain `PutItem` it has always been,
 * guard fragments and all: it names no object, so its re-land is an ordinary
 * last-write-wins outcome rather than unreadable data, and a transaction would
 * charge twice the write capacity to buy that.
 *
 * The question is the descriptor's because this path runs whenever an offloader
 * is *configured*, and such an adapter still writes inline whenever the payload
 * is under its threshold — so asking the adapter would tokenise writes that
 * strand nothing.
 *
 * `guard` absent means no pin at all, which is the unconditional overwrite the
 * exhausted compare-and-swap below falls back to.
 *
 * Both callers arrive here and the token is worth different things to each. On
 * a pinned attempt the condition already turns a re-send away, so what the
 * token adds is narrower: inside one budget, a re-send of an attempt that
 * *committed* and lost its acknowledgement is answered from the idempotency
 * cache rather than colliding with the `writeGroup` it wrote itself — the
 * collision {@link verifyAfterFailure} otherwise has to spend a read to
 * resolve. On the unconditional overwrite below there is no condition at all,
 * so the token is the only thing standing between a lost acknowledgement and a
 * second landing.
 *
 * A rejection buys nothing either way, and the loop above is built on that: a
 * cancelled attempt commits nothing, so nothing is cached for its token and a
 * retry would be a fresh evaluation — see {@link putIdempotently}, and the
 * transaction helper it delegates to, for that precondition stated in full.
 * It is why a lost compare-and-swap re-reads and re-pins rather than
 * re-sending, and why each re-pin calls this function afresh for a new token.
 * The deadline inside the helper is what holds each budget within the window
 * the token is honoured for; the token enforces no window itself.
 */
async function commitSpecialRow(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
  guard?: RevisionGuard,
  signal?: AbortSignal,
): Promise<void> {
  if (referencesS3Object(item.value)) {
    await putIdempotently(context, item, guard, signal);
    return;
  }
  await withDynamoDBRetry(
    (request) =>
      context.client.put({ TableName: context.tableName, Item: item, ...guard }, request),
    retryFor(context, signal),
  );
}

/**
 * Retry a conditional put up to {@link OVERWRITE_CAS_MAX_ATTEMPTS} times,
 * re-reading the row each time a racer's write invalidates the pinned
 * `writeGroup`. Extracted from {@link writeSpecialItem} to keep both
 * functions under the repo's block-nesting limit.
 *
 * A rejection is not proof a competitor won: `withDynamoDBRetry` retries
 * transient errors, so an attempt can commit server-side, its response can be
 * lost, and the retried put can hit the row it just wrote and fail the same
 * guard — indistinguishable from a competitor's win by the rejection alone.
 * Each attempt's pinned observation is captured in `attempted` before the
 * put, so that when {@link verifyAfterFailure} finds the row already holding
 * *this item's own* `writeGroup`, the outcome reports having superseded
 * whatever `attempted` held — never the item's own just-committed payload,
 * which would strand the live row pointing at a deleted object.
 *
 * Only a rejection whose re-read proves some *other* writer holds the row is
 * retried; every other failure is already settled by the verification.
 *
 * Each iteration calls {@link commitSpecialRow} afresh, so an offloaded item's
 * re-pin draws a new request token. That is required rather than merely tidy:
 * the re-pinned request carries a different `ConditionExpression`, and the same
 * token presented with changed parameters inside the service's window is
 * refused outright.
 */
async function attemptCasWrites(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
  initial: SpecialRowState,
  signal?: AbortSignal,
): Promise<CasAttemptResult> {
  let observed = initial;
  for (let attempt = 1; attempt <= OVERWRITE_CAS_MAX_ATTEMPTS; attempt++) {
    const attempted = observed;
    try {
      await commitSpecialRow(
        context,
        item,
        revisionGuard(WRITE_GROUP_ATTRIBUTE, attempted),
        signal,
      );
      return { done: true, outcome: { committed: true, superseded: attempted.value } };
    } catch (error) {
      const verified = await verifyAfterFailure(context, item, attempted, error as Error);
      if (!verified.observed || !isConditionalCheckFailed(error as Error)) {
        return { done: true, outcome: verified.outcome };
      }
      observed = verified.observed;
    }
  }
  return { done: false, observed };
}

/**
 * Overwrite the row unconditionally once the compare-and-swap budget is spent,
 * verifying rather than assuming if that write fails too.
 *
 * This is the call a request token helps most, and the reason it is worth
 * carrying one here at all. Every other write on this path is pinned, so a
 * re-send that arrives after the first attempt already committed is turned away
 * by its own guard; this one has no condition, so nothing but the token stops
 * it landing a second time — over whatever a competitor wrote in between, and
 * over a row whose object a concurrent cleanup has since released. It still
 * takes the shape {@link commitSpecialRow} gives it, so an inline payload is
 * written exactly as before.
 */
async function overwriteUnconditionally(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
  observed: SpecialRowState,
  signal?: AbortSignal,
): Promise<SpecialWriteOutcome> {
  try {
    await commitSpecialRow(context, item, undefined, signal);
    return { committed: true, superseded: observed.value };
  } catch (error) {
    return (await verifyAfterFailure(context, item, observed, error as Error)).outcome;
  }
}

/**
 * The plain put used without an offloader: no object exists to orphan, so no
 * swap and no read. A failure is reported as not committed without verifying,
 * which stays truthful because there is no upload for the caller to keep.
 *
 * It stays a plain put whatever the descriptor says. A row read back from a
 * table an offloading adapter wrote can name an object, but this adapter cannot
 * have uploaded it, so there is nothing here for a token to protect and no
 * reason to pay a transaction's write capacity.
 */
async function writeWithoutOffloader(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
  signal?: AbortSignal,
): Promise<SpecialWriteOutcome> {
  try {
    await withDynamoDBRetry(
      (request) => context.client.put({ TableName: context.tableName, Item: item }, request),
      retryFor(context, signal),
    );
    return { committed: true };
  } catch (error) {
    return { committed: false, error: error as Error };
  }
}

/**
 * Overwrite one special row, pinned to the `writeGroup` this call observed, and
 * report the descriptor it superseded.
 *
 * Overwriting is correct for special channels — every reference implementation
 * does it — but two concurrent calls to the same channel both read the same
 * previous descriptor and both delete it, orphaning the loser's upload. Pinning
 * the observed `writeGroup` and re-reading on rejection makes each call
 * supersede exactly one payload.
 *
 * `BatchWriteItem` cannot carry conditions, which is why this path issues
 * individual puts; a call holds at most one row per special channel, so that is
 * four writes at worst.
 *
 * The compare-and-swap runs only when an offloader is configured — matching
 * `store/internal/persist.ts` — because without one there is no S3 object to
 * orphan, so a plain unconditional put stays correct and costs no extra
 * ConsistentRead or write capacity (see {@link writeWithoutOffloader}).
 *
 * A failure of the first read, before any put, is no verdict read from the row,
 * and this call releases its own upload only on one. It is therefore reported
 * the way every unverified outcome is: `committed: true` with the error, so the
 * caller keeps the upload and leaves it to the lifecycle rule.
 *
 * Accepts: `item` — one special-channel row, carrying this call's `writeGroup`.
 * `signal` — aborts the attempts.
 *
 * Returns: whether this item's upload must be kept (see
 * {@link SpecialWriteOutcome}), the descriptor it superseded when the write
 * committed, and the failure when there was one.
 *
 * Throws: nothing. The caller runs this concurrently with the regular writes
 * under `Promise.all`, whose own cleanup depends on every branch resolving
 * rather than short-circuiting.
 *
 * Guarantees: each call supersedes exactly one payload, so two concurrent calls
 * to the same channel cannot both delete the same object and orphan the loser's
 * upload.
 */
export async function writeSpecialItem(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
  signal?: AbortSignal,
): Promise<SpecialWriteOutcome> {
  if (!context.offloader) return writeWithoutOffloader(context, item, signal);
  try {
    const initial = await readSpecialRow(context, item);
    const attempt = await attemptCasWrites(context, item, initial, signal);
    if (attempt.done) return attempt.outcome;
    context.logger.warn(
      'putWrites: special-write compare-and-swap exhausted; overwriting unconditionally, which ' +
        'can orphan one S3 object under a concurrent call (reclaimed by ensureS3LifecycleRule)',
      { sortKey: item.SK, channel: item.channel, attempts: OVERWRITE_CAS_MAX_ATTEMPTS },
    );
    return await overwriteUnconditionally(context, item, attempt.observed, signal);
  } catch (error) {
    /**
     * The attempts settle every put they issue, so what reaches here is the
     * initial read, before any put, or the warning. Neither is a verdict read
     * from the row, and this call releases its own upload only on one, so it is
     * reported the way every unverified outcome is: kept, for the lifecycle rule.
     */
    return { committed: true, error: error as Error };
  }
}
