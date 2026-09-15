import type { PayloadDescriptor } from '../../shared/codec/codec';
import { isConditionalCheckFailed, rejectedItem } from '../../shared/dynamodb/conditional-put';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { verifyRow, type WriteVerdict } from '../../shared/dynamodb/write-verify';
import type { CheckpointWriteItem } from '../types';
import type { CheckpointerContext } from './setup';
import { specialRowProbe } from './special-write-verify';
import { rejectionProvesForeignRow, reportGuardRejection } from './write-guard';

/**
 * One upload this call made that its own row does not reference, together with
 * the descriptor held by the row that *does* exist.
 *
 * Both halves are needed. A payload is addressed by the hash of its bytes under
 * its row's path, so two calls writing the same value for the same write upload
 * to one object — and the loser's "dead" upload is then the winner's live one.
 * `live` is what lets the cleanup tell those apart; it is undefined when no row
 * exists at all, and the upload is then dead beyond doubt.
 */
export interface DeadUpload {
  item: CheckpointWriteItem;
  live?: PayloadDescriptor;
}

/**
 * Outcome of {@link writeRegularItems}: never rejects. `deadUploads` holds
 * exactly the items whose own S3 upload is confirmed unreferenced by this
 * call's row — a verified non-commit, or a guard rejection whose returned row
 * provably belongs to another call. Everything else either committed, was
 * turned away by a row this call may have written itself, or could not be
 * verified; none of those may be cleaned up.
 */
export interface RegularWriteOutcome {
  deadUploads: DeadUpload[];
  error?: Error;
}

/** What a post-failure read established about one regular write. */
interface FailureVerdict {
  verdict: WriteVerdict;
  live?: PayloadDescriptor;
}

/**
 * Resolve a non-guard failure by reading the row back. Without an offloader
 * there is no object to protect, so the write is simply reported as not landed
 * and the caller's cleanup is a no-op. The row holding this call's own
 * `writeGroup` means the put landed and only its response was lost.
 */
async function verifyFailure(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
): Promise<FailureVerdict> {
  if (!context.offloader) return { verdict: 'not-landed' };
  const { verdict, row } = await verifyRow(context, specialRowProbe(item));
  return { verdict, live: row?.value as PayloadDescriptor | undefined };
}

/** The descriptor on the row that turned a guarded write away, when it carried one. */
function rejectedDescriptor(error: Error): PayloadDescriptor | undefined {
  return rejectedItem(error)?.value as PayloadDescriptor | undefined;
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
 *
 * Accepts: `items` — this call's regular write rows; empty writes nothing.
 * `signal` — aborts the puts.
 *
 * Returns: which items are known not to have committed — whose own uploads are
 * therefore dead — and the first genuine failure, if any.
 *
 * Throws: nothing. Every put settles before this resolves, because the caller
 * runs it beside the special writes under `Promise.all` and its cleanup depends
 * on every branch resolving rather than short-circuiting.
 *
 * Guarantees: first-write-wins. A rejection means the row is already held, which
 * is the expected outcome of a retry, not a failure.
 */
export async function writeRegularItems(
  context: CheckpointerContext,
  items: CheckpointWriteItem[],
  signal?: AbortSignal,
): Promise<RegularWriteOutcome> {
  const results = await Promise.allSettled(
    items.map((item) =>
      withDynamoDBRetry(
        () =>
          context.client.put({
            TableName: context.tableName,
            Item: item,
            ConditionExpression: 'attribute_not_exists(PK)',
            ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
          }),
        retryFor(context, signal),
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
      if (rejectionProvesForeignRow(item, reason)) {
        outcome.deadUploads.push({ item, live: rejectedDescriptor(reason) });
      }
      continue;
    }
    const { verdict, live } = await verifyFailure(context, item);
    if (verdict === 'landed') continue;
    if (verdict === 'not-landed') outcome.deadUploads.push({ item, live });
    outcome.error = outcome.error ?? reason;
  }
  return outcome;
}
