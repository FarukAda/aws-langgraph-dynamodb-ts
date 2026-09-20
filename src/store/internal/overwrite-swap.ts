import {
  isConditionalCheckFailed,
  OVERWRITE_CAS_MAX_ATTEMPTS,
  rejectedItem,
  REVISION_ATTRIBUTE,
  revisionGuard,
} from '../../shared/dynamodb/conditional-put';
import { putIdempotently, referencesS3Object } from '../../shared/dynamodb/idempotent-write';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { StoreItemRecord } from '../types';
import { type ExistingRecordMeta, existingFrom, readExisting } from './read-existing';
import type { StoreContext } from './setup';

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
 * That bound is not a second retry limit; it is what keeps the budget inside
 * the window the token is honoured for. The token enforces no window of its
 * own, and a re-send arriving after it has closed is a new write that lands
 * over whatever has replaced this row and names an object a concurrent release
 * may already have taken away.
 *
 * The pin decides which half of the token's guarantee applies, and the swap
 * below is written around the answer. An attempt the guard turns away commits
 * nothing, so nothing is cached for its token and a retry would be a fresh
 * evaluation — {@link putIdempotently}, and the transaction helper it
 * delegates to, state that precondition in full — which is why a loss is
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
  if (referencesS3Object(record.value)) {
    await putIdempotently(context, record, guard);
    return;
  }
  await withDynamoDBRetry(
    () => context.client.put({ TableName: context.tableName, Item: record, ...guard }),
    context.retry,
  );
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
      observed = rejected
        ? existingFrom(rejected)
        : await readExisting(context, record.PK, record.SK);
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
