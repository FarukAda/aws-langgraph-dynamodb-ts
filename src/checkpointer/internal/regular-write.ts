import {
  isConditionalCheckFailed,
  type RevisionGuard,
} from '../../shared/dynamodb/conditional-put';
import { putIdempotently, referencesS3Object } from '../../shared/dynamodb/idempotent-write';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { PARTITION_KEY_ATTRIBUTE } from '../../shared/dynamodb/table-schema';
import { verifyRow, type WriteVerdict } from '../../shared/dynamodb/write-verify';
import type { CheckpointWriteItem } from './rows';
import type { CheckpointerContext } from './setup';
import { specialRowProbe } from './special-write-verify';
import { rejectionProvesForeignRow, reportGuardRejection } from './write-guard';

/**
 * Outcome of {@link writeRegularItems}: never rejects. `deadUploads` holds
 * exactly the items whose own S3 upload is confirmed unreferenced by this
 * call's row — a verified non-commit, or a guard rejection whose returned row
 * provably belongs to another call. Everything else either committed, was
 * turned away by a row this call may have written itself, or could not be
 * verified; none of those may be cleaned up.
 *
 * No other row is consulted before an upload in `deadUploads` is released: its
 * key ends in this call's own `writeGroup`, which no row of another call names.
 */
export interface RegularWriteOutcome {
  deadUploads: CheckpointWriteItem[];
  error?: Error;
}

/**
 * First-write-wins, with the row that turned the write away attached to the
 * rejection, so a losing call can tell a duplicate of its own from one another
 * call committed without spending a read.
 */
const FIRST_WRITE_WINS: RevisionGuard = {
  ConditionExpression: `attribute_not_exists(${PARTITION_KEY_ATTRIBUTE})`,
  ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
};

/**
 * Commit one regular row under {@link FIRST_WRITE_WINS}.
 *
 * The write takes one of two shapes, and which one is decided by the
 * **descriptor** rather than by the adapter. An item whose payload was
 * offloaded goes out as a one-item `TransactWriteItems` under a client request
 * token, so a re-send of a write the service already applied is discarded
 * instead of landing a second time — which, after the row and its object have
 * been removed by something else, would put back a row naming an object nobody
 * will write again. **That "something else" is not the losing call here**: a
 * regular write only ever releases its own upload, and nothing supersedes a
 * regular-write row. It is a concurrent `deleteThread`, or a `ttl` sweep
 * followed by the S3 lifecycle rule — which is what the re-land test models. An item
 * whose payload is inline goes out as the plain `PutItem` it has always been,
 * guard fragments and all: it names no object, so its re-land is an ordinary
 * first-write-wins outcome rather than unreadable data, and a transaction would
 * charge twice the write capacity to buy that.
 *
 * The question is the descriptor's because an adapter *with* an offloader
 * configured still writes inline whenever the payload is under its threshold,
 * so asking the adapter would tokenise a fan-out of small writes that strand
 * nothing — the very workload this path exists to keep cheap.
 *
 * One item per transaction, never several: a transaction cancels whole, so
 * batching would let one duplicate write — the expected outcome of a retry
 * under first-write-wins — turn away every neighbour it travelled with.
 *
 * What {@link FIRST_WRITE_WINS} changes about the token. It is a condition, so
 * an attempt it turns away commits nothing, DynamoDB caches nothing for that
 * attempt's token, and the retry is a fresh evaluation of first-write-wins
 * against the table as it stands then — the token carries none of it forward,
 * and {@link putIdempotently}, with the transaction helper it delegates to, is
 * where that precondition is stated in full. What the token does carry is the
 * other half: inside one budget, a re-send of an attempt that *committed* and
 * lost its acknowledgement is answered from the idempotency cache instead of
 * colliding with the row it wrote itself. That collision is the rejection
 * {@link rejectionProvesForeignRow} exists to disbelieve, and on the inline
 * shape it is still live, because a `PutItem` has no token to be answered
 * from.
 *
 * The deadline inside the helper is what keeps the budget within the window
 * the token is honoured for; the token enforces no window of its own. Past it
 * a re-send is a new write, and a new write here is this row put back after a
 * concurrent `deleteThread` released its object, or after a ttl sweep and the
 * lifecycle rule did.
 */
async function commitItem(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
  signal?: AbortSignal,
): Promise<void> {
  if (referencesS3Object(item.value)) {
    await putIdempotently(context, item, FIRST_WRITE_WINS, signal);
    return;
  }
  await withDynamoDBRetry(
    (request) =>
      context.client.put(
        { TableName: context.tableName, Item: item, ...FIRST_WRITE_WINS },
        request,
      ),
    retryFor(context, signal),
  );
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
): Promise<WriteVerdict> {
  if (!context.offloader) return 'not-landed';
  const { verdict } = await verifyRow(context, specialRowProbe(item));
  return verdict;
}

/**
 * Write regular items with a first-write-wins guard. Every write fully settles
 * (`Promise.allSettled`) before this resolves and never rejects; a genuine
 * failure is reported via `error`, not thrown. The fan-out is one call per
 * item whichever shape {@link commitItem} gives that item's write.
 *
 * A failure is not proof of a non-commit: `withDynamoDBRetry` re-issues a put
 * whose response was lost, and the re-issues can time out at the transport, so
 * the budget is spent on a `RETRY_EXHAUSTED` error while the row is live.
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
  const results = await Promise.allSettled(items.map((item) => commitItem(context, item, signal)));
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
    if (verdict === 'landed') continue;
    if (verdict === 'not-landed') outcome.deadUploads.push(item);
    outcome.error = outcome.error ?? reason;
  }
  return outcome;
}
