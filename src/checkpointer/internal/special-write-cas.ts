import type { PayloadDescriptor } from '../../shared/codec/codec';
import {
  isConditionalCheckFailed,
  OVERWRITE_CAS_MAX_ATTEMPTS,
  revisionGuard,
} from '../../shared/dynamodb/conditional-put';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { CheckpointWriteItem } from '../types';
import type { CheckpointerContext } from './setup';

/**
 * A special row already carries a per-call ULID in `writeGroup`, so it needs no
 * extra revision attribute to compare and swap on.
 */
const SPECIAL_REVISION_ATTRIBUTE = 'writeGroup';

/** What a special item's row held before this call tried to overwrite it. */
export interface SpecialRowState {
  exists: boolean;
  value?: PayloadDescriptor;
  revision?: string;
}

/** Outcome of one special item's conditional write. Never thrown, always returned. */
export interface SpecialWriteOutcome {
  committed: boolean;
  superseded?: PayloadDescriptor;
  error?: Error;
}

/** Read a special row's current descriptor and the writeGroup guarding it. */
export async function readSpecialRow(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
): Promise<SpecialRowState> {
  const result = await withDynamoDBRetry(() =>
    context.client.get({
      TableName: context.tableName,
      Key: { PK: item.PK, SK: item.SK },
      ConsistentRead: true,
      ProjectionExpression: '#v, #g',
      ExpressionAttributeNames: { '#v': 'value', '#g': SPECIAL_REVISION_ATTRIBUTE },
    }),
  );
  if (!result.Item) return { exists: false };
  return {
    exists: true,
    value: result.Item.value as PayloadDescriptor | undefined,
    revision: result.Item[SPECIAL_REVISION_ATTRIBUTE] as string | undefined,
  };
}

/** Outcome of {@link attemptCasWrites}: either a winning put, or every attempt rejected. */
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
 * put, so that when a re-read finds the row already holding *this item's
 * own* `writeGroup`, the outcome reports having superseded whatever
 * `attempted` held — never the item's own just-committed payload, which
 * would strand the live row pointing at a deleted object.
 */
async function attemptCasWrites(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
  initial: SpecialRowState,
): Promise<CasAttemptResult> {
  let observed = initial;
  for (let attempt = 1; attempt <= OVERWRITE_CAS_MAX_ATTEMPTS; attempt++) {
    const attempted = observed;
    try {
      await withDynamoDBRetry(() =>
        context.client.put({
          TableName: context.tableName,
          Item: item,
          ...revisionGuard(SPECIAL_REVISION_ATTRIBUTE, attempted),
        }),
      );
      return { done: true, outcome: { committed: true, superseded: attempted.value } };
    } catch (error) {
      if (!isConditionalCheckFailed(error as { name?: string })) throw error;
      observed = await readSpecialRow(context, item);
      if (observed.revision === item.writeGroup) {
        return { done: true, outcome: { committed: true, superseded: attempted.value } };
      }
    }
  }
  return { done: false, observed };
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
 * ConsistentRead or write capacity.
 *
 * Never rejects: the caller runs this concurrently with the regular writes
 * under `Promise.all`, whose own cleanup depends on every branch resolving
 * rather than short-circuiting.
 */
export async function writeSpecialItem(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
): Promise<SpecialWriteOutcome> {
  try {
    if (!context.offloader) {
      await withDynamoDBRetry(() =>
        context.client.put({ TableName: context.tableName, Item: item }),
      );
      return { committed: true };
    }
    const initial = await readSpecialRow(context, item);
    const attempt = await attemptCasWrites(context, item, initial);
    if (attempt.done) return attempt.outcome;
    context.logger.warn(
      'putWrites: special-write compare-and-swap exhausted; overwriting unconditionally, which ' +
        'can orphan one S3 object under a concurrent call (reclaimed by ensureS3LifecycleRule)',
      { sortKey: item.SK, channel: item.channel, attempts: OVERWRITE_CAS_MAX_ATTEMPTS },
    );
    await withDynamoDBRetry(() => context.client.put({ TableName: context.tableName, Item: item }));
    return { committed: true, superseded: attempt.observed.value };
  } catch (error) {
    return { committed: false, error: error as Error };
  }
}
