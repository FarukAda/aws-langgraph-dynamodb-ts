import {
  isConditionalCheckFailed,
  OVERWRITE_CAS_MAX_ATTEMPTS,
  revisionGuard,
} from '../../shared/dynamodb/conditional-put';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import type { CheckpointWriteItem } from '../types';
import type { CheckpointerContext } from './setup';
import {
  readSpecialRow,
  SPECIAL_REVISION_ATTRIBUTE,
  type SpecialRowState,
  type SpecialWriteOutcome,
  verifyAfterFailure,
} from './special-write-verify';

/** Outcome of {@link attemptCasWrites}: either a settled write, or every attempt rejected. */
type CasAttemptResult =
  { done: true; outcome: SpecialWriteOutcome } | { done: false; observed: SpecialRowState };

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
      await withDynamoDBRetry(
        () =>
          context.client.put({
            TableName: context.tableName,
            Item: item,
            ...revisionGuard(SPECIAL_REVISION_ATTRIBUTE, attempted),
          }),
        retryFor(context, signal),
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
 * verifying rather than assuming if that put fails too.
 */
async function overwriteUnconditionally(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
  observed: SpecialRowState,
  signal?: AbortSignal,
): Promise<SpecialWriteOutcome> {
  try {
    await withDynamoDBRetry(
      () => context.client.put({ TableName: context.tableName, Item: item }),
      retryFor(context, signal),
    );
    return { committed: true, superseded: observed.value };
  } catch (error) {
    return (await verifyAfterFailure(context, item, observed, error as Error)).outcome;
  }
}

/**
 * The plain put used without an offloader: no object exists to orphan, so no
 * swap and no read. A failure is reported as not committed without verifying,
 * which stays truthful because there is no upload for the caller to keep.
 */
async function writeWithoutOffloader(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
  signal?: AbortSignal,
): Promise<SpecialWriteOutcome> {
  try {
    await withDynamoDBRetry(
      () => context.client.put({ TableName: context.tableName, Item: item }),
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
