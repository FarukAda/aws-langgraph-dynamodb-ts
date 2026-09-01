import { isConditionalCheckFailed } from '../../shared/dynamodb/conditional-put';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { CheckpointWriteItem } from '../types';
import type { CheckpointerContext } from './setup';
import { readSpecialRow } from './special-write-verify';
import { rejectionProvesForeignRow, reportGuardRejection } from './write-guard';

/**
 * Outcome of {@link writeRegularItems}: never rejects. `deadUploads` holds
 * exactly the items whose own S3 upload is confirmed unreferenced — a
 * verified non-commit, or a guard rejection whose returned row provably
 * belongs to another call — and is therefore safe to delete. Everything else
 * either committed, was turned away by a row this call may have written
 * itself, or could not be verified; none of those may be cleaned up.
 */
export interface RegularWriteOutcome {
  deadUploads: CheckpointWriteItem[];
  error?: Error;
}

/** What a post-failure read established about one regular write. */
type FailureVerdict = 'committed' | 'not-committed' | 'unverified';

/**
 * Resolve a non-guard failure by reading the row back. Without an offloader
 * there is no object to protect, so the write is simply reported as not
 * committed and the caller's cleanup is a no-op. The row holding this call's
 * own `writeGroup` means the put landed and only its response was lost.
 */
async function verifyFailure(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
): Promise<FailureVerdict> {
  if (!context.offloader) return 'not-committed';
  try {
    const observed = await readSpecialRow(context, item);
    return observed.revision === item.writeGroup ? 'committed' : 'not-committed';
  } catch {
    return 'unverified';
  }
}

/**
 * Write regular items with a first-write-wins guard. Every `PutCommand` fully
 * settles (`Promise.allSettled`) before this resolves and never rejects; a
 * genuine failure is reported via `error`, not thrown.
 *
 * A failure is not proof of a non-commit: `withDynamoDBRetry` re-issues a put
 * whose response was lost, and the re-issues can time out at the transport, so
 * the budget is spent on a `RetryExhaustedError` while the row is live.
 * Treating that as "never reached DynamoDB" deleted the object the live row
 * pointed at, making the checkpoint's pending writes unreadable forever. Each
 * such failure is therefore verified against the row before it is classified,
 * and a committed one is not an error at all.
 */
export async function writeRegularItems(
  context: CheckpointerContext,
  items: CheckpointWriteItem[],
): Promise<RegularWriteOutcome> {
  const results = await Promise.allSettled(
    items.map((item) =>
      withDynamoDBRetry(() =>
        context.client.put({
          TableName: context.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK)',
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      ),
    ),
  );
  const outcome: RegularWriteOutcome = { deadUploads: [] };
  for (const [index, result] of results.entries()) {
    if (result.status === 'fulfilled') continue;
    const item = items[index];
    const reason = result.reason as Error;
    if (isConditionalCheckFailed(reason)) {
      reportGuardRejection(context, item, reason);
      if (rejectionProvesForeignRow(item, reason)) outcome.deadUploads.push(item);
      continue;
    }
    const verdict = await verifyFailure(context, item);
    if (verdict === 'committed') continue;
    if (verdict === 'not-committed') outcome.deadUploads.push(item);
    outcome.error = outcome.error ?? reason;
  }
  return outcome;
}
