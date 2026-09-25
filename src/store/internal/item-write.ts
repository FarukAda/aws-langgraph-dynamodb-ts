/**
 * Hides how an item's row is replaced or removed without stranding its S3
 * object or deleting one a live row still names.
 *
 * A put with an offloader pins its write to the revision it observed and
 * re-reads when a concurrent writer wins; once the budget is spent it
 * overwrites and may leak one object to the lifecycle rule. A delete pins
 * itself the same way. Either releases the payload it superseded only once its
 * own write committed, and a write whose outcome was lost is read back before
 * anything is released. Without an offloader there is no object to protect,
 * and a put is a plain write.
 */

import { collectS3Keys, type DescriptorRef } from '../../shared/codec/codec';
import { cleanUpS3Orphans } from '../../shared/codec/s3/offloader';
import {
  commitRow,
  deleteIdempotently,
  isConditionalCheckFailed,
  isRowAbsent,
  OVERWRITE_CAS_MAX_ATTEMPTS,
  rejectedItem,
  revisionGuard,
  verifyRow,
  type WriteVerdict,
} from '../../shared/dynamodb/idempotent-write';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { type RowKey, rowKeyOf } from '../../shared/dynamodb/table-schema';
import { hasErrorCode } from '../../shared/errors/base-error';
import { ErrorCode } from '../../shared/errors/error-code';
import type { StoreAddress } from './parse';
import {
  type ExistingRecordMeta,
  existingFrom,
  itemRowKey,
  readExisting,
  REVISION_ATTRIBUTE,
  type StoreItemRecord,
} from './rows';
import type { StoreContext } from './setup';
import { dropVectorWhenGone } from './vector-index';

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
 * delete that landed. Under a request token that read has little to settle,
 * because every attempt inside one budget re-sends the identical request and a
 * replay is answered from the idempotency cache rather than re-applied; only
 * the last attempt's outcome is in question.
 *
 * `isRowAbsent` reports a read that itself failed as `false` — "not confirmed",
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
  if (isRetryExhausted(error) && (await isRowAbsent(context, key))) return undefined;
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
 *   That covers both interleavings that would otherwise erase a live item's vector: a
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
 * row's when something did. It is never read back from the response, so by
 * construction the object of a delete whose acknowledgement was lost is not
 * leaked. Nothing is released while the outcome is unknown: only a
 * confirmed absence or a confirmed delete licenses it. And the backend's
 * `delete` is never reached without a confirmation immediately before it, on
 * every path including the one whose key never had a row: one rule with no
 * exception, because an exception on a repair-shaped path is where the erasure
 * comes back unnoticed.
 */
export async function deleteStoreItem(context: StoreContext, address: StoreAddress): Promise<void> {
  const key = itemRowKey(address);
  const existing = await readExisting(context, key);
  const released = existing.exists ? await removeObservedRow(context, key, existing) : existing;
  if (released === undefined) {
    context.logger.warn('store.delete: compare-and-swap exhausted; the item was not deleted', {
      namespace: address.namespace,
      key: address.key,
      attempts: OVERWRITE_CAS_MAX_ATTEMPTS,
    });
  }
  await dropVectorWhenGone(context, address);
  if (context.offloader && released?.value) {
    await cleanUpS3Orphans(context.offloader, {
      keys: collectS3Keys([released.value]),
      operation: 'store.delete',
      logger: context.logger,
      scope: [...address.namespace, address.key],
    });
  }
}

/**
 * Best-effort delete of the S3 object behind `release`, if it names one.
 *
 * `release` is absent when there is nothing to release, and a row this library
 * did not write can hold `null` there, so it is tested for truthiness. `scope`
 * is passed for a descriptor read back from the row (the superseded value) and
 * omitted for this call's own upload.
 */
async function cleanUp(
  context: StoreContext,
  release: DescriptorRef | undefined,
  label: string,
  scope?: readonly string[],
): Promise<void> {
  if (!context.offloader || !release) return;
  await cleanUpS3Orphans(context.offloader, {
    keys: collectS3Keys([release]),
    operation: label,
    logger: context.logger,
    ...(scope === undefined ? {} : { scope }),
  });
}

/**
 * Put the record and clean up whichever side is now dead.
 *
 * The compare-and-swap path runs **only when an offloader is configured**:
 * without one there is no S3 object to orphan, so a plain last-write-wins put
 * stays correct and costs no extra write capacity (DynamoDB charges for a
 * failed conditional write too). With one, the swap is what lets this call
 * delete exactly the payload it superseded rather than a descriptor a racer may
 * already have replaced.
 *
 * Every failure reaching the catch arrives after at least one put was issued —
 * `putWithRevisionSwap` only re-reads from inside its own catch — so none of
 * them proves a non-commit on its own: a put can commit server-side and lose
 * its response, and a `ConditionalCheckFailedException` is as consistent with
 * hitting the row this call just wrote as with a competitor's win. The row is
 * therefore read back (`verifyWriteLanded`) before anything is deleted. Only a
 * confirmed `'not-landed'` deletes this record's own object; a confirmed
 * `'landed'` cleans up the previous object like the success path and swallows
 * the error, and an `'unverified'` read deletes nothing and rethrows — leaking
 * one object at worst rather than stranding a live row pointing at a deleted
 * one. The verification compares the per-call `rev`, so an inline record is
 * verified too: otherwise a lost acknowledgement of an inline overwrite would be
 * reported as a failure while the previous offloaded object was never cleaned.
 *
 * Neither release reads the row again first. The record's object is uploaded
 * under the record's own `rev`, which no other put uses, so no row another put
 * commits names it; and the record names only that object, never the one it
 * superseded.
 *
 * Accepts: `record` — the fully encoded row, its payload already uploaded if it
 * was offloaded. `existing` — what the caller read before encoding.
 *
 * Returns: nothing. The row is committed and exactly one side's object, at
 * most, has been released.
 *
 * Throws: whatever the write throws, unless the verification proves the write
 * landed after all — in which case the error is swallowed and the cleanup runs
 * as on the success path.
 *
 * Guarantees: this record's own object is released only after a read proves
 * the write did not land, and a superseded object only after this record is
 * committed. The failure modes are ordered by which is worse: a leaked object
 * costs storage until the lifecycle rule reclaims it, while a row pointing at a
 * deleted object is unreadable data, so every ambiguous case leaks instead of
 * deletes.
 */
export async function persistRecord(
  context: StoreContext,
  record: StoreItemRecord,
  existing: ExistingRecordMeta,
): Promise<void> {
  let superseded = existing;
  try {
    if (context.offloader) {
      superseded = await putWithRevisionSwap(context, record, existing);
    } else {
      await withDynamoDBRetry(
        (request) => context.client.put({ TableName: context.tableName, Item: record }, request),
        context.retry,
      );
    }
  } catch (error) {
    const verdict = await verifyWriteLanded(context, record);
    if (verdict === 'not-landed') await cleanUp(context, record.value, 'store.put');
    if (verdict !== 'landed') throw error;
  }
  await cleanUp(context, superseded.value, 'store.put.overwrite', [
    ...record.namespace,
    record.key,
  ]);
}

/**
 * Put the record, optionally pinned to the revision the caller observed.
 *
 * The write takes one of two shapes, and which one is decided by the
 * **descriptor** rather than by the adapter. A record whose payload was
 * offloaded goes out as a one-item `TransactWriteItems` under a client request
 * token, so a re-send of a write the service already applied is discarded
 * instead of landing a second time — which, after a concurrent operation has
 * released that row's object, would leave a live row naming nothing. A record
 * whose payload is inline goes out as the plain `PutItem` it has always been,
 * guard fragments and all: it names no object, so its re-land is an ordinary
 * last-write-wins outcome rather than unreadable data, and a transaction would
 * charge twice the write capacity to buy that.
 *
 * The question is the descriptor's because an adapter *with* an offloader
 * configured still writes inline whenever the payload is under its threshold,
 * so asking the adapter would tokenise writes that strand nothing.
 *
 * `observed` absent means no pin at all, which is the unconditional write the
 * exhausted swap below falls back to — and the one a token helps most, since
 * with no condition to turn it away nothing else stops a re-send from landing.
 *
 * Two things do change for a caller on the offloaded path, both priced in the
 * design. The budget is additionally bounded by `MAX_WRITE_LIFETIME_MS`, so a
 * caller who configures an aggressively long retry policy can now see it end
 * there rather than at its own last attempt; at the defaults the whole budget
 * is orders of magnitude shorter and the bound is unreachable. And a
 * transaction conflicts with any concurrent write to the same item, so under
 * heavy contention this put can exhaust its budget where a plain `PutItem`
 * would simply have won the race.
 *
 * That bound does end a long budget early, as above, but it is not there as a
 * retry limit of its own: it is what keeps the budget inside the window the
 * token is honoured for. The token enforces no window of its own, and a
 * re-send arriving after it has closed is a new write that lands over whatever
 * has replaced this row and names an object a concurrent release may already
 * have taken away.
 *
 * The pin decides which half of the token's guarantee applies, and the swap
 * below is written around the answer. An attempt the guard turns away commits
 * nothing, so nothing is cached for its token and a retry would be a fresh
 * evaluation — {@link commitRow}, and the transaction helper it delegates to,
 * state that precondition in full —
 * which is why a loss is
 * answered by re-reading and re-pinning under a new token rather than by
 * re-sending this one. What the token does cover is a
 * *committed* attempt whose acknowledgement was lost: within one budget its
 * re-send is answered from the idempotency cache instead of being turned away
 * by the `rev` it wrote itself, which is the rejection the swap below resolves
 * by re-reading, and which the inline shape can still produce.
 */
async function put(
  context: StoreContext,
  record: StoreItemRecord,
  observed?: ExistingRecordMeta,
): Promise<void> {
  const guard = observed ? revisionGuard(REVISION_ATTRIBUTE, observed) : undefined;
  await commitRow(context, record, record.value, { guard });
}

/**
 * Commit `record`, re-reading and retrying while another writer holds the row,
 * and return the state this write actually superseded — the only descriptor
 * safe to delete afterwards.
 *
 * Without the swap both racers read the same previous descriptor, both commit,
 * and both delete it, orphaning the loser's own upload. Retrying against the
 * *re-read* state is what makes each writer supersede exactly one payload.
 *
 * A rejection is not proof a competitor won: `withDynamoDBRetry` retries
 * transient errors, so an attempt can commit server-side, its response can be
 * lost, and the retried put can hit the row it just wrote and fail the same
 * guard — indistinguishable from a competitor's win by the rejection alone.
 * Each attempt's pinned observation is captured in `attempted` before the
 * put, so that when a re-read finds the row already holding *this call's
 * own* `rev`, the swap returns whatever `attempted` held — never this
 * record's own just-committed value, which would strand the live row
 * pointing at a deleted object. That comparison is guarded on `rev` being
 * set: `rev` is optional on the record type, and an unnonced record against a
 * pre-0.9.0 revision-less row would otherwise match `undefined === undefined`
 * and claim a race it never entered.
 *
 * On exhaustion the write proceeds unconditionally and warns. That is
 * deliberate: the fallback is precisely the pre-0.9.0 behaviour — one possible
 * orphan, reclaimed by a lifecycle rule — so pathological contention degrades
 * instead of turning a working put into an error. `createdAt` is refreshed from
 * each re-read so a row created by whoever won keeps its true creation time.
 *
 * Accepts: `record` — the row to commit, carrying this call's own `rev`.
 * `existing` — what the caller read before encoding, used as the first pin; an
 * `exists: false` observation pins "no row", so a creation races correctly too.
 *
 * Returns: the state this write actually superseded — the descriptor safe to
 * delete — which is the last observation the winning put was pinned to, never
 * this record's own value.
 *
 * Throws: whatever the put throws other than a conditional-check failure; those
 * are the swap's own business.
 *
 * Guarantees: at most {@link OVERWRITE_CAS_MAX_ATTEMPTS} conditional puts, and
 * a re-read only when the rejection did not already carry the row that caused
 * it.
 */
export async function putWithRevisionSwap(
  context: StoreContext,
  record: StoreItemRecord,
  existing: ExistingRecordMeta,
): Promise<ExistingRecordMeta> {
  let observed = existing;
  for (let attempt = 1; attempt <= OVERWRITE_CAS_MAX_ATTEMPTS; attempt++) {
    const attempted = observed;
    try {
      await put(context, record, attempted);
      return attempted;
    } catch (error) {
      const rejection = error as Error;
      if (!isConditionalCheckFailed(rejection)) throw rejection;
      /** The rejection carries the row that turned it away; the read is spent only when it does not. */
      const rejected = rejectedItem(rejection);
      observed = rejected ? existingFrom(rejected) : await readExisting(context, rowKeyOf(record));
      if (record.rev !== undefined && observed.revision === record.rev) return attempted;
      /** A row that vanished between attempts (a concurrent delete) makes this a fresh creation. */
      record.createdAt = observed.exists
        ? (observed.createdAt ?? record.createdAt)
        : record.updatedAt;
    }
  }
  context.logger.warn(
    'store.put: compare-and-swap exhausted; overwriting unconditionally, which can orphan one ' +
      'S3 object under a concurrent put (reclaimed by ensureS3LifecycleRule)',
    { namespace: record.namespace, key: record.key, attempts: OVERWRITE_CAS_MAX_ATTEMPTS },
  );
  await put(context, record);
  return observed;
}

/**
 * Whether `error` is a spent retry budget.
 *
 * Accepts: any error, and equally anything else a `throw` can produce.
 * Recognised by brand and code: the code is the one thing an error crossing a
 * module or realm boundary can be relied on to keep.
 *
 * Returns: whether the write is ambiguous for the reason retries were spent,
 * which is the only failure a verification read is allowed to resolve.
 *
 * Throws: **nothing**, for any value. A value carrying no such code is not a
 * spent budget, so the caller rethrows it rather than spending a read on it.
 */
export function isRetryExhausted(error: Error): boolean {
  return hasErrorCode(error, ErrorCode.RETRY_EXHAUSTED);
}

/**
 * Read `record`'s row back to establish what an ambiguous write actually did,
 * comparing the row's revision with the one this write carried. Every put
 * stamps a fresh per-call `rev`, so the comparison works for inline and
 * offloaded records alike.
 *
 * Accepts: `record` — the row this call wrote, carrying the `rev` it stamped.
 * A record with no `rev` has nothing to compare and is reported `'not-landed'`
 * without spending a read.
 *
 * Returns: `'landed'`, `'not-landed'` or `'unverified'`; see
 * {@link WriteVerdict} for what each answer licenses the caller to do. Only the
 * `rev` is read: an offloaded record's key ends in that same `rev`, so the row
 * holding a different one never names this write's object, and a cleanup
 * needs nothing more from it.
 *
 * Throws: nothing — a failed verification is `'unverified'`, which is an
 * answer, not an error.
 */
export async function verifyWriteLanded(
  context: StoreContext,
  record: { PK: string; SK: string; rev?: string },
): Promise<WriteVerdict> {
  const { verdict } = await verifyRow(context, {
    key: rowKeyOf(record),
    kind: 'attribute',
    attribute: REVISION_ATTRIBUTE,
    expected: record.rev,
  });
  return verdict;
}
