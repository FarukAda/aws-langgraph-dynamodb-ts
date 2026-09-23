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
import { partitionKey, sortKey } from './keys';
import type { StoreAddress } from './parse';
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
 *
 * The pin and the token close different failures and the loop needs both. The
 * pin refuses a delete of a row a put replaced after the observation, which
 * takes no lost acknowledgement at all — only a put landing between the
 * pre-read and this write. The token covers the lost acknowledgement, and what
 * it buys is that a rejection reaching the catch below is *informative*:
 * inside one budget the re-send of an attempt that already committed is
 * answered from the idempotency cache rather than turned away by whatever has
 * arrived at the key since — a rejection the loop would re-pin on, deleting
 * next iteration a row this call never read — so a cancellation means a
 * genuine race and not this call's own landed delete reported back as a loss. An unconditional
 * `DeleteItem` can be neither turned away nor deduplicated, which is why the
 * write takes a transaction's shape ({@link deleteIdempotently}).
 *
 * A rejection carries no idempotency forward — a cancelled attempt commits
 * nothing, so nothing is cached for its token — and here that is exactly what
 * is wanted, because the next iteration must be evaluated afresh, against a
 * fresh pin taken from the row the rejection returned. The deadline inside the
 * helper keeps each iteration's retrying within the window its token is
 * honoured for; past that window a re-send is re-evaluated like any other
 * request and the rejection is ambiguous again.
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
 * Drop the item's vector, but only on a fresh read that finds no row at the
 * key.
 *
 * The question is deliberately **not** "did this call remove the row" — that
 * one is true in exactly the interleaving that goes wrong. It is "does the key
 * hold a row *now*", which a racing put that recreated it and a
 * compare-and-swap that left it alone both answer the same way, and which costs
 * a point read of this library's own table rather than anything the backend has
 * to offer. The reconciler already asks it before pruning a vector, so the
 * delete path is no longer the less careful of the two.
 *
 * A read that itself fails answers "not confirmed" and keeps the vector: a
 * stale vector for a deleted item, which `reconcileVectorIndex` removes, rather
 * than a missing one for a live item, which is the defect this exists for.
 */
async function dropVectorWhenGone(
  context: StoreContext,
  address: StoreAddress,
  key: RowKey,
): Promise<void> {
  const backend = context.vectorBackend;
  if (backend === undefined) return;
  if (!(await rowIsAbsent(context, key))) {
    context.logger.info('store.delete: kept a vector whose item was not confirmed gone', {
      namespace: address.namespace,
      key: address.key,
    });
    return;
  }
  await syncVectorIndex(backend, address.namespace, address.key, undefined, context.logger);
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
 * repair path callers have today — and the vector sync goes through the same
 * confirmation as every other path rather than letting the pre-read stand in
 * for it, so the put that lands mid-call keeps its vector too.
 *
 * What a caller can and cannot tell apart:
 *
 * - **Compare-and-swap exhaustion resolves rather than throwing.** Three
 *   consecutive writers between a re-pin and its attempt leave the item in
 *   place, release nothing — correctly, a live row names the object — and emit
 *   one `warn`. Throwing instead would add a failure mode to an interleaving
 *   that succeeds today, which every caller deleting in a `finally` would have
 *   to handle.
 * - **The vector is dropped only on a confirmation, and that window is
 *   narrowed rather than closed.** Immediately before the backend call — and
 *   above the S3 cleanup, so no round trip with its own retries sits inside the
 *   window — one strongly-consistent projected read asks whether the key holds
 *   a row now, and a row that is there keeps its vector and logs one `info`.
 *   That covers both interleavings that used to erase a live item's vector: a
 *   put recreating the row this call removed, and the compare-and-swap above
 *   resolving with the row untouched. What is left is a put committing between
 *   that read and the backend call, two adjacent statements apart. Closing it
 *   needs a compare-and-swap **on the vector backend** — delete this vector
 *   only if it is still the one written at time T — which the `VectorBackend`
 *   contract cannot express and no implementation would be obliged to honour,
 *   so `reconcileVectorIndex` stays the named repair for it.
 * - **A deadline cut and a spent budget are one error.** The transaction's
 *   budget is additionally bounded by `MAX_WRITE_LIFETIME_MS`, so a caller who
 *   configures a long retry policy can see the budget end there rather than at
 *   its own last attempt; both arrive as `RETRY_EXHAUSTED` and neither says
 *   which bound stopped it.
 * - **The pre-read is a new way for this call to fail.** It issues no read
 *   today, so a delete of a key with *no row* can now fail where it always
 *   succeeded. Nothing has been written when it does: no row removed, no object
 *   released, no vector touched. The error types a caller sees are unchanged —
 *   `store.delete` already documents `RETRY_EXHAUSTED` — but "deleting an
 *   item that is not there is not an error" now describes the outcome rather
 *   than the round trip.
 *
 * Accepts: `address` — parsed; the namespace and key the cleanup is scoped and
 * logged by, and the row's key is derived from it.
 *
 * Returns: nothing. The item is gone, was already gone, or — on
 * compare-and-swap exhaustion — is still there and was left alone.
 *
 * Throws: whatever the pre-read throws; whatever the transaction throws other
 * than a guard rejection, which is this call's own business; and
 * `RETRY_EXHAUSTED` when the budget is spent and a read cannot confirm the
 * row is gone. Three things about that list are worth saying rather than
 * leaving to be inferred. The **pre-read** is why a delete of a key with no row
 * can now fail at all, and nothing has been written when it does. A **guard
 * rejection** is refused rather than raised: the row it names was replaced
 * after this call observed it, so removing it would erase that put and release
 * the object the put uploaded, and re-pinning on the row the rejection carried
 * is strictly safer than either raising or proceeding. And **exhausting** those
 * re-pins throws nothing either — it resolves with the item still there and one
 * `warn`, so a caller that needs the item gone re-runs once the key is
 * quiescent rather than catching anything.
 *
 * Guarantees: the object released is the **last observation's**, on every path
 * that releases at all — the pre-read's when nothing re-pinned, the rejected
 * row's when something did. It is never read back from the response, so the
 * object a delete whose acknowledgement was lost removed is no longer leaked by
 * construction. Nothing is released while the outcome is unknown: only a
 * confirmed absence or a confirmed delete licenses it. And the backend's
 * `delete` is never reached without a confirmation immediately before it, on
 * every path including the one whose key never had a row: one rule with no
 * exception, because an exception on a repair-shaped path is where the erasure
 * comes back unnoticed.
 */
export async function deleteStoreItem(context: StoreContext, address: StoreAddress): Promise<void> {
  const key: RowKey = {
    PK: partitionKey(address.namespace),
    SK: sortKey(address.namespace, address.key),
  };
  const existing = await readExisting(context, key.PK, key.SK);
  const released = existing.exists ? await removeObservedRow(context, key, existing) : existing;
  if (released === undefined) {
    context.logger.warn('store.delete: compare-and-swap exhausted; the item was not deleted', {
      namespace: address.namespace,
      key: address.key,
      attempts: OVERWRITE_CAS_MAX_ATTEMPTS,
    });
  }
  await dropVectorWhenGone(context, address, key);
  if (context.offloader && released?.value) {
    await cleanUpS3Orphans(
      context.offloader,
      collectS3Keys([released.value]),
      'store.delete',
      context.logger,
      { scope: [...address.namespace, address.key] },
    );
  }
}
