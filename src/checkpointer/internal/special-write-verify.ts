import type { PayloadDescriptor } from '../../shared/codec/codec';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { CheckpointWriteItem } from '../types';
import type { CheckpointerContext } from './setup';

/**
 * A special row already carries a per-call ULID in `writeGroup`, so it needs no
 * extra revision attribute to compare and swap on.
 */
export const SPECIAL_REVISION_ATTRIBUTE = 'writeGroup';

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

/** What a post-failure verification read established about the attempt. */
export interface VerifiedFailure {
  outcome: SpecialWriteOutcome;
  /** Present only when the row was read and holds some other writer's group. */
  observed?: SpecialRowState;
}

/** Read a special row's current descriptor and the writeGroup guarding it. */
export async function readSpecialRow(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
): Promise<SpecialRowState> {
  const result = await withDynamoDBRetry(
    () =>
      context.client.get({
        TableName: context.tableName,
        Key: { PK: item.PK, SK: item.SK },
        ConsistentRead: true,
        ProjectionExpression: '#v, #g',
        ExpressionAttributeNames: { '#v': 'value', '#g': SPECIAL_REVISION_ATTRIBUTE },
      }),
    context.retry,
  );
  if (!result.Item) return { exists: false };
  return {
    exists: true,
    value: result.Item.value as PayloadDescriptor | undefined,
    revision: result.Item[SPECIAL_REVISION_ATTRIBUTE] as string | undefined,
  };
}

/**
 * Read the row back after a put failed, and report what that failure actually
 * did — never assuming it did nothing.
 *
 * No rejection is proof of a non-commit. `withDynamoDBRetry` re-issues a put
 * whose response was lost, and those re-issues can time out at the transport
 * without ever reaching DynamoDB, so the budget is spent on a
 * `RetryExhaustedError` and never on a `ConditionalCheckFailedException` — yet
 * the row is committed. Reporting that as a confirmed non-commit let
 * `writeSpecialItemsWithCleanup` delete the S3 object the live row points at,
 * so every later `getTuple()` on that checkpoint failed with `NoSuchKey`,
 * permanently.
 *
 * Three answers are possible:
 * - the row holds this item's own `writeGroup`: the write landed, and the
 *   descriptor this attempt pinned is the dead one.
 * - the row holds some other group: the write is confirmed not to be what is
 *   live, so this item's own upload is the dead one. `observed` is returned so
 *   a rejected compare-and-swap can re-pin and try again.
 * - the read itself fails: nothing is confirmed, so the outcome still reports a
 *   commit and keeps the originating error. That leaks one S3 object at worst
 *   (reclaimed by `ensureS3LifecycleRule`) where the alternative strands a live
 *   row — the same trade `store/internal/persist.ts` makes.
 */
export async function verifyAfterFailure(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
  attempted: SpecialRowState,
  error: Error,
): Promise<VerifiedFailure> {
  try {
    const observed = await readSpecialRow(context, item);
    if (observed.revision === item.writeGroup) {
      return { outcome: { committed: true, superseded: attempted.value } };
    }
    return { outcome: { committed: false, error }, observed };
  } catch {
    return { outcome: { committed: true, error } };
  }
}
