import type { PutOperation } from '@langchain/langgraph-checkpoint';

import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import {
  isConditionalCheckFailed,
  OVERWRITE_CAS_MAX_ATTEMPTS,
  rejectedItem,
  REVISION_ATTRIBUTE,
  revisionGuard,
} from '../../shared/dynamodb/conditional-put';
import { deleteIdempotently } from '../../shared/dynamodb/idempotent-write';
import { syncVectorIndex } from './index-sync';
import { type ExistingRecordMeta, existingFrom, readExisting } from './read-existing';
import type { StoreContext } from './setup';
import { isRetryExhausted, rowIsAbsent } from './write-verify';

/** The row this delete addresses. A type alias, so it is also a `Key` document. */
type RowKey = { PK: string; SK: string };

/**
 * What a refused attempt licenses next: the observation to re-pin on, or
 * `undefined` for "stop, the row is gone".
 *
 * Two failures end the loop without an error, and they are different events. A
 * cancellation carrying **no** row means the row was deleted between the
 * observation and this attempt, so there is nothing left to remove. A spent
 * retry budget is *ambiguous* — the delete may have landed with only its
 * acknowledgement lost — and is resolved the way `persistRecord` resolves its
 * own: with a strongly-consistent read, treating a confirmed absence as a
 * delete that landed. Under a request token that read has less to settle than
 * it used to, because every attempt inside one budget re-sends the identical
 * request and a replay is answered from the idempotency cache rather than
 * re-applied; only the last attempt's outcome is in question.
 *
 * `rowIsAbsent` reports a read that itself failed as `false` — "not confirmed",
 * never "still there" — so an unknown outcome rethrows and releases nothing.
 */
async function repinOrResolve(
  context: StoreContext,
  key: RowKey,
  error: Error,
): Promise<ExistingRecordMeta | undefined> {
  if (isConditionalCheckFailed(error)) {
    /** Raw `AttributeValue`s: `rejectedItem` unmarshalls, `existingFrom` does not. */
    const rejected = rejectedItem(error);
    return rejected === undefined ? undefined : existingFrom(rejected);
  }
  if (isRetryExhausted(error) && (await rowIsAbsent(context, key))) return undefined;
  throw error;
}

/**
 * Delete the row while it still holds the revision this call observed,
 * re-pinning from each rejection, and report the observation whose descriptor
 * the delete superseded.
 *
 * Returns `undefined` when the compare-and-swap is exhausted: the row is still
 * there, held by whoever kept winning, and nothing may be released because a
 * live row names it.
 */
async function removeObservedRow(
  context: StoreContext,
  key: RowKey,
  existing: ExistingRecordMeta,
): Promise<ExistingRecordMeta | undefined> {
  let observed = existing;
  for (let attempt = 1; attempt <= OVERWRITE_CAS_MAX_ATTEMPTS; attempt++) {
    try {
      await deleteIdempotently(context, key, revisionGuard(REVISION_ATTRIBUTE, observed));
      return observed;
    } catch (error) {
      const repinned = await repinOrResolve(context, key, error as Error);
      if (repinned === undefined) return observed;
      observed = repinned;
    }
  }
  return undefined;
}

/**
 * Delete the item and, when a vector backend is configured, drop its vector.
 *
 * The row is read first, then removed inside a one-item `TransactWriteItems`
 * conditioned on the revision that read observed. An unconditional delete
 * erases a put that commits between the caller's call and the write — no lost
 * acknowledgement needed, no S3 involved — and releases the object that put
 * uploaded. The condition refuses that, and the request token makes a lost
 * acknowledgement harmless: the replay is answered from DynamoDB's idempotency
 * cache instead of removing whatever has arrived since.
 *
 * **A key with no row costs one read and sends no write at all**, which is the
 * same race closed from the other side: there is nothing to pin, so a put that
 * lands mid-call survives. The S3 release and the vector sync still run, since
 * a key with no row can still have a stranded vector and clearing it is a
 * repair path callers have today.
 *
 * What a caller can and cannot tell apart:
 *
 * - **Compare-and-swap exhaustion resolves rather than throwing.** Three
 *   consecutive writers between a re-pin and its attempt leave the item in
 *   place, release nothing — correctly, a live row names the object — and emit
 *   one `warn`. Throwing instead would add a failure mode to an interleaving
 *   that succeeds today, which every caller deleting in a `finally` would have
 *   to handle. **One thing about this outcome is not yet right:** the vector
 *   sync below still runs, so a configured `vectorBackend` loses the live
 *   row's vector and `search` stops returning an item `get` still returns,
 *   until `reconcileVectorIndex` runs. It is a new state - before this change
 *   no interleaving left the row alive - and it is closed by gating that call
 *   on a confirmation that the row is really gone.
 * - **A deadline cut and a spent budget are one error.** The transaction's
 *   budget is additionally bounded by `MAX_WRITE_LIFETIME_MS`, so a caller who
 *   configures a long retry policy can see the budget end there rather than at
 *   its own last attempt; both arrive as `RetryExhaustedError` and neither says
 *   which bound stopped it.
 * - **The pre-read is a new way for this call to fail.** It issues no read
 *   today, so a delete of a key with *no row* can now fail where it always
 *   succeeded. Nothing has been written when it does: no row removed, no object
 *   released, no vector touched. The error types a caller sees are unchanged —
 *   `store.delete` already documents `RetryExhaustedError` — but "deleting an
 *   item that is not there is not an error" now describes the outcome rather
 *   than the round trip.
 *
 * Accepts: `op` — the delete operation, for the namespace and key the cleanup
 * is scoped and logged by. `pk`/`sk` — the row's key.
 *
 * Returns: nothing. The item is gone, was already gone, or — on
 * compare-and-swap exhaustion — is still there and was left alone.
 *
 * Throws: whatever the pre-read throws; whatever the transaction throws other
 * than a guard rejection, which is this call's own business; and
 * `RetryExhaustedError` when the budget is spent and a read cannot confirm the
 * row is gone.
 *
 * Guarantees: the object released is the **last observation's**, on every path
 * that releases at all — the pre-read's when nothing re-pinned, the rejected
 * row's when something did. It is never read back from the response, so the
 * object a delete whose acknowledgement was lost removed is no longer leaked by
 * construction. Nothing is released while the outcome is unknown: only a
 * confirmed absence or a confirmed delete licenses it.
 */
export async function deleteStoreItem(
  context: StoreContext,
  op: PutOperation,
  pk: string,
  sk: string,
): Promise<void> {
  const existing = await readExisting(context, pk, sk);
  const released = existing.exists
    ? await removeObservedRow(context, { PK: pk, SK: sk }, existing)
    : existing;
  if (released === undefined) {
    context.logger.warn('store.delete: compare-and-swap exhausted; the item was not deleted', {
      namespace: op.namespace,
      key: op.key,
      attempts: OVERWRITE_CAS_MAX_ATTEMPTS,
    });
  }
  if (context.offloader && released?.value) {
    await cleanUpS3Orphans(
      context.offloader,
      collectS3Keys([released.value]),
      'store.delete',
      context.logger,
      { scope: [...op.namespace, op.key] },
    );
  }
  if (context.vectorBackend) {
    await syncVectorIndex(context.vectorBackend, op.namespace, op.key, undefined, context.logger);
  }
}
