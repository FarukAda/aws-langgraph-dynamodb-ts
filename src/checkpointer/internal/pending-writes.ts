/**
 * Hides how one `putWrites` call's rows commit, and which uploads each outcome
 * releases.
 *
 * A positional write is first-write-wins: a retried task must not overwrite
 * what its first run committed, and a rejection is the expected outcome of a
 * retry, not a failure. A special channel's write overwrites, as every reference
 * checkpointer does, under a compare-and-swap on the row's `writeGroup` so two
 * concurrent calls cannot both release the same superseded payload. Around both,
 * an upload is released only when a read, or the row a rejection returned,
 * proves no live row names it — never on an outcome nothing confirmed.
 */

import { type PayloadDescriptor, collectS3Keys } from '../../shared/codec/codec';
import { cleanUpS3Orphans } from '../../shared/codec/s3/offloader';
import type { DocItem } from '../../shared/dynamodb/client';
import {
  commitRow,
  isConditionalCheckFailed,
  OVERWRITE_CAS_MAX_ATTEMPTS,
  readRow,
  rejectedItem,
  type RevisionGuard,
  revisionGuard,
  type RowProbe,
  verdictFor,
  verifyRow,
  type WriteVerdict,
} from '../../shared/dynamodb/idempotent-write';
import { withDynamoDBRetry, retryFor } from '../../shared/dynamodb/retry';
import { PARTITION_KEY_ATTRIBUTE, rowKeyOf } from '../../shared/dynamodb/table-schema';
import { truncateForLog } from '../../shared/logging/truncate';
import type { ThreadId } from './parse';
import { type CheckpointWriteItem, WRITE_GROUP_ATTRIBUTE } from './rows';
import type { CheckpointerContext } from './setup';

/** One call's rows, ready to commit. */
export interface PendingWriteBatch {
  /** The caller's thread, which scopes every superseded object this commit may release. */
  readonly threadId: ThreadId;
  readonly items: CheckpointWriteItem[];
  readonly signal: AbortSignal | undefined;
}

/**
 * Commit one call's pending-write rows, then release the uploads the outcome
 * proves dead.
 *
 * Accepts: `batch` — the call's thread, its encoded rows (positional and
 * special together, in any order), and its signal.
 *
 * Returns: nothing, once every write has settled and the cleanup has run.
 *
 * Throws: the first genuine write failure, after every write has settled and
 * the cleanup has run. A first-write-wins rejection is not a failure.
 */
export async function commitPendingWrites(
  context: CheckpointerContext,
  batch: PendingWriteBatch,
): Promise<void> {
  const special = batch.items.filter((item) => item.index < 0);
  const regular = batch.items.filter((item) => item.index >= 0);
  const [specialError, regularOutcome] = await Promise.all([
    writeSpecialItemsWithCleanup(context, batch.threadId, special, batch.signal),
    writeRegularItems(context, regular, batch.signal),
  ]);
  await releaseDeadUploads(context, regularOutcome.deadUploads);
  const firstError = specialError ?? regularOutcome.error;
  if (firstError) throw firstError;
}

/**
 * Best-effort delete the offloaded objects of uploads this call's rows do not
 * reference, if an offloader is configured. Each key ends in this call's own
 * `writeGroup`, so a row another call wrote in its place never names it.
 */
async function releaseDeadUploads(
  context: CheckpointerContext,
  dead: CheckpointWriteItem[],
): Promise<void> {
  if (!context.offloader) return;
  await cleanUpS3Orphans(context.offloader, {
    keys: collectS3Keys(dead.map((item) => item.value)),
    operation: 'putWrites',
    logger: context.logger,
  });
}

/** Outcome of {@link attemptCasWrites}: either a settled write, or every attempt rejected. */
type CasAttemptResult =
  { done: true; outcome: SpecialWriteOutcome } | { done: false; observed: SpecialRowState };

/**
 * Commit one special row, optionally pinned to the `writeGroup` the caller
 * observed.
 *
 * The write takes one of two shapes, and which one is decided by the
 * **descriptor** rather than by the adapter. An item whose payload was
 * offloaded goes out as a one-item `TransactWriteItems` under a client request
 * token, so a re-send of a write the service already applied is discarded
 * instead of landing a second time — which, after a concurrent call has
 * released that row's object, would leave a live row naming nothing. An item
 * whose payload is inline goes out as the plain `PutItem` it has always been,
 * guard fragments and all: it names no object, so its re-land is an ordinary
 * last-write-wins outcome rather than unreadable data, and a transaction would
 * charge twice the write capacity to buy that.
 *
 * The question is the descriptor's because this path runs whenever an offloader
 * is *configured*, and such an adapter still writes inline whenever the payload
 * is under its threshold — so asking the adapter would tokenise writes that
 * strand nothing.
 *
 * `guard` absent means no pin at all, which is the unconditional overwrite the
 * exhausted compare-and-swap below falls back to.
 *
 * Both callers arrive here and the token is worth different things to each. On
 * a pinned attempt the condition already turns a re-send away, so what the
 * token adds is narrower: inside one budget, a re-send of an attempt that
 * *committed* and lost its acknowledgement is answered from the idempotency
 * cache rather than colliding with the `writeGroup` it wrote itself — the
 * collision {@link verifyAfterFailure} otherwise has to spend a read to
 * resolve. On the unconditional overwrite below there is no condition at all,
 * so the token is the only thing standing between a lost acknowledgement and a
 * second landing.
 *
 * A rejection buys nothing either way, and the loop above is built on that: a
 * cancelled attempt commits nothing, so nothing is cached for its token and a
 * retry would be a fresh evaluation — see {@link commitRow}, and the
 * transaction helper it delegates to, for that precondition stated in full.
 * It is why a lost compare-and-swap re-reads and re-pins rather than
 * re-sending, and why each re-pin calls this function afresh for a new token.
 * The deadline inside the helper is what holds each budget within the window
 * the token is honoured for; the token enforces no window itself.
 */
async function commitSpecialRow(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
  guard?: RevisionGuard,
  signal?: AbortSignal,
): Promise<void> {
  await commitRow(context, item, item.value, { guard, signal });
}

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
 *
 * Each iteration calls {@link commitSpecialRow} afresh, so an offloaded item's
 * re-pin draws a new request token. That is required rather than merely tidy:
 * the re-pinned request carries a different `ConditionExpression`, and the same
 * token presented with changed parameters inside the service's window is
 * refused outright.
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
      await commitSpecialRow(
        context,
        item,
        revisionGuard(WRITE_GROUP_ATTRIBUTE, attempted),
        signal,
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
 * verifying rather than assuming if that write fails too.
 *
 * This is the call a request token helps most, and the reason it is worth
 * carrying one here at all. Every other write on this path is pinned, so a
 * re-send that arrives after the first attempt already committed is turned away
 * by its own guard; this one has no condition, so nothing but the token stops
 * it landing a second time — over whatever a competitor wrote in between, and
 * over a row whose object a concurrent cleanup has since released. It still
 * takes the shape {@link commitSpecialRow} gives it, so an inline payload is
 * written exactly as before.
 */
async function overwriteUnconditionally(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
  observed: SpecialRowState,
  signal?: AbortSignal,
): Promise<SpecialWriteOutcome> {
  try {
    await commitSpecialRow(context, item, undefined, signal);
    return { committed: true, superseded: observed.value };
  } catch (error) {
    return (await verifyAfterFailure(context, item, observed, error as Error)).outcome;
  }
}

/**
 * The plain put used without an offloader: no object exists to orphan, so no
 * swap and no read. A failure is reported as not committed without verifying,
 * which stays truthful because there is no upload for the caller to keep.
 *
 * It stays a plain put whatever the descriptor says. A row read back from a
 * table an offloading adapter wrote can name an object, but this adapter cannot
 * have uploaded it, so there is nothing here for a token to protect and no
 * reason to pay a transaction's write capacity.
 */
async function writeWithoutOffloader(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
  signal?: AbortSignal,
): Promise<SpecialWriteOutcome> {
  try {
    await withDynamoDBRetry(
      (request) => context.client.put({ TableName: context.tableName, Item: item }, request),
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
 * `store/internal/item-write.ts` — because without one there is no S3 object to
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

/** What a special item's row held before this call tried to overwrite it. */
export interface SpecialRowState {
  exists: boolean;
  value?: PayloadDescriptor;
  revision?: string;
}

/**
 * Outcome of one special item's conditional write. Never thrown, always returned.
 *
 * `committed` is true whenever this call's own upload must be kept: a confirmed
 * commit, or an outcome nothing confirmed, which then also carries `error`. It
 * is false only when the write is confirmed not to have committed, or when no
 * offloader is configured and there is no upload to keep.
 */
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

/**
 * The probe that recognises `item`'s own write on its row.
 *
 * Accepts: `item` — the row this call tried to write, carrying its own
 * `writeGroup`.
 *
 * Returns: the probe, which projects the guard attribute and the descriptor —
 * the descriptor because a caller that has to re-pin a compare-and-swap needs
 * the value it lost to, not just the fact that it lost.
 *
 * Throws: nothing.
 */
export function specialRowProbe(item: CheckpointWriteItem): RowProbe {
  return {
    key: rowKeyOf(item),
    kind: 'attribute',
    attribute: WRITE_GROUP_ATTRIBUTE,
    expected: item.writeGroup,
    also: ['value'],
  };
}

/** A read row, in the shape the compare-and-swap pins its next attempt to. */
function stateOf(row: DocItem | undefined): SpecialRowState {
  if (!row) return { exists: false };
  return {
    exists: true,
    value: row.value as PayloadDescriptor | undefined,
    revision: row[WRITE_GROUP_ATTRIBUTE] as string | undefined,
  };
}

/**
 * Read a special row's current descriptor and the writeGroup guarding it.
 *
 * Accepts: `item` — the row to read, by its key.
 *
 * Returns: the row's state, with `exists: false` when there is none — which is
 * what a first writer pins its compare-and-swap to.
 *
 * Throws: whatever the read throws. Deliberately not swallowed: the caller
 * reports that failure with its own cause rather than guessing at the row's
 * state, which is why this is separate from {@link verifyAfterFailure}.
 */
export async function readSpecialRow(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
): Promise<SpecialRowState> {
  return stateOf(await readRow(context, specialRowProbe(item)));
}

/**
 * Read the row back after a put failed, and report what that failure actually
 * did — never assuming it did nothing.
 *
 * A guard rejection already carries the row that turned it away (see
 * `rejectedItem`), so the strongly-consistent read is spent only for a failure
 * that does not: a lost response, or a rejection whose row vanished since.
 *
 * Three answers are possible:
 * - the row holds this item's own `writeGroup`: the write landed, and the
 *   descriptor this attempt pinned is the dead one.
 * - the row holds some other group: the write is confirmed not to be what is
 *   live, so this item's own upload is dead — its key ends in this call's own
 *   group, which the row another writer wrote does not name. `observed` is
 *   returned so a rejected compare-and-swap can re-pin and try again.
 * - the read itself fails: nothing is confirmed, so the outcome still reports a
 *   commit and keeps the originating error. That leaks one S3 object at worst
 *   (reclaimed by `ensureS3LifecycleRule`) where the alternative strands a live
 *   row — the same trade `store/internal/item-write.ts` makes.
 *
 * Accepts: `attempted` — the state this attempt pinned, whose descriptor is the
 * one superseded if the write did land. `error` — the failure being explained.
 *
 * Returns: the outcome, and the row's observed state when another writer holds
 * it, so a rejected compare-and-swap can re-pin and try again.
 *
 * Throws: nothing. It exists to turn a failure into a decision.
 *
 * Guarantees: a guard rejection already carries the row that turned it away, so
 * the strongly-consistent read is spent only for a failure that does not — a
 * lost response, or a rejection whose row vanished since.
 */
export async function verifyAfterFailure(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
  attempted: SpecialRowState,
  error: Error,
): Promise<VerifiedFailure> {
  const probe = specialRowProbe(item);
  const rejected = isConditionalCheckFailed(error) ? rejectedItem(error) : undefined;
  const { verdict, row } = rejected
    ? { verdict: verdictFor(probe, rejected), row: rejected }
    : await verifyRow(context, probe);
  if (verdict === 'landed') return { outcome: { committed: true, superseded: attempted.value } };
  if (verdict === 'unverified') return { outcome: { committed: true, error } };
  return { outcome: { committed: false, error }, observed: stateOf(row) };
}

/**
 * Best-effort delete the S3 objects backing `descriptors`, if offloading is on.
 * An absent entry is skipped, and so is a `null` one, which a row this library
 * did not write can hold. `scope` is given for descriptors read back from rows
 * (the superseded values) and omitted for this call's own uploads.
 */
async function deleteDescriptors(
  context: CheckpointerContext,
  descriptors: (PayloadDescriptor | undefined)[],
  label: string,
  scope?: readonly string[],
): Promise<void> {
  if (!context.offloader) return;
  await cleanUpS3Orphans(context.offloader, {
    keys: collectS3Keys(descriptors.filter((ref): ref is PayloadDescriptor => Boolean(ref))),
    operation: label,
    logger: context.logger,
    ...(scope === undefined ? {} : { scope }),
  });
}

/**
 * Write special (negative-index) items, then clean up the correct side of each.
 *
 * Overwrite is correct here, matching every reference checkpointer. Each item
 * is written with a compare-and-swap on its row's `writeGroup` (see
 * {@link writeSpecialItem}) so a concurrent call to the same special channel
 * cannot make both callers delete the same superseded object and orphan one
 * upload. A committed item cleans up the payload it actually superseded, and an
 * item confirmed never to have committed cleans up its own new upload. Neither
 * reads the row again first: every call uploads under its own `writeGroup`, so
 * a row another call writes never names this item's upload, and this item's
 * row names only that upload, never the payload it superseded.
 *
 * "Confirmed" is load-bearing, and {@link writeSpecialItem} is what earns it:
 * an ambiguous failure, or a first read of the row that failed, is reported as
 * committed unless a read proves otherwise. Deleting on *unknown* would strand
 * a live row pointing at a deleted object; leaking one object instead is
 * recoverable.
 *
 * Accepts: `items` — this call's special-channel rows; empty writes nothing.
 * `threadId` — the caller's, which scopes every object this cleanup may delete.
 *
 * Returns: the first failure, or undefined when every item committed.
 *
 * Throws: nothing — a failure is reported via the return value, because the
 * caller runs this concurrently with `writeRegularItems` under `Promise.all`,
 * whose own cleanup depends on every branch resolving rather than
 * short-circuiting.
 *
 * Guarantees: a superseded payload is released only once the item that
 * superseded it committed, and an item's own upload only once a read, or the
 * row returned with its rejected write, shows the row holding another call's
 * write or no row at all.
 */
export async function writeSpecialItemsWithCleanup(
  context: CheckpointerContext,
  threadId: ThreadId,
  items: CheckpointWriteItem[],
  signal?: AbortSignal,
): Promise<Error | undefined> {
  if (items.length === 0) return undefined;
  const outcomes = await Promise.all(
    items.map(async (item): Promise<[CheckpointWriteItem, SpecialWriteOutcome]> => [
      item,
      await writeSpecialItem(context, item, signal),
    ]),
  );
  await deleteDescriptors(
    context,
    outcomes.filter(([, o]) => o.committed).map(([, o]) => o.superseded),
    'putWrites.special.previous',
    [threadId],
  );
  await deleteDescriptors(
    context,
    outcomes.filter(([, o]) => !o.committed).map(([item]) => item.value),
    'putWrites.special.newUpload',
  );
  return outcomes.find(([, o]) => o.error)?.[1].error;
}

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
 * and {@link commitRow}, with the transaction helper it delegates to, is where
 * that precondition is stated in full. What the token does carry is the
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
  await commitRow(context, item, item.value, { guard: FIRST_WRITE_WINS, signal });
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

/**
 * The channel recorded on the row that turned a write away, or undefined when
 * the service returned no attributes (`ReturnValuesOnConditionCheckFailure:
 * 'ALL_OLD'` attaches the existing item to the exception at no extra round trip).
 */
function rejectedChannel(error: Error): string | undefined {
  return rejectedItem(error)?.channel as string | undefined;
}

/**
 * Report a guard rejection. Sort keys carry their channel, so a rejection
 * normally means this exact (task, channel, occurrence) row is already
 * committed — a genuine duplicate, and the expected outcome of a retry. A row
 * held by a *different* channel is not something this adapter can produce, so
 * it is reported at `warn`: the write was not persisted and something else
 * wrote to this key space.
 *
 * Accepts: `error` — the rejection, which carries the row that caused it when
 * the service returned attributes. No attributes means the two cases cannot be
 * told apart, and the ordinary duplicate is the one assumed: warning on every
 * unattributed rejection would cry wolf on the expected outcome of a retry.
 *
 * Returns: nothing. A rejection is not a failure here — first-write-wins means
 * losing is a normal outcome — so it is reported, not thrown.
 *
 * Throws: nothing.
 */
export function reportGuardRejection(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
  error: Error,
): void {
  const found = rejectedChannel(error);
  if (found !== undefined && found !== item.channel) {
    context.logger.warn('putWrites: write row held by an unexpected channel; write not persisted', {
      sortKey: item.SK,
      expected: item.channel,
      found: truncateForLog(found),
    });
    return;
  }
  context.logger.debug('putWrites: skipped a write already committed for this task and channel', {
    sortKey: item.SK,
    channel: item.channel,
  });
}

/**
 * Whether the rejection's returned row provably belongs to another `putWrites`
 * call.
 *
 * Accepts: `error` — the rejection. `item` — the row this call tried to write,
 * carrying its own `writeGroup`.
 *
 * Returns: whether the row that won carries a *different* group, which is the
 * only evidence that this call's own upload is dead and safe to delete. A
 * retried put whose response was lost can be rejected by the row it wrote
 * itself, so an equal group — or no attributes at all — proves nothing and is
 * answered `false`: the object is then left to the lifecycle rule rather than
 * deleted out from under a live row.
 *
 * Throws: nothing.
 */
export function rejectionProvesForeignRow(item: CheckpointWriteItem, error: Error): boolean {
  const group = rejectedItem(error)?.writeGroup as string | undefined;
  return group !== undefined && group !== item.writeGroup;
}
