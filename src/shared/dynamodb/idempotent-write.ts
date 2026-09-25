/**
 * Hides how a row write whose outcome matters is issued and settled.
 *
 * A write can lose its acknowledgement, be re-sent by the retry layer, race a
 * concurrent writer, or leave an S3 object that only its row names. Three
 * things answer that, and they are decided together here: a guard that admits
 * the write only while the row still holds what the caller observed; a client
 * request token, drawn once per logical write with a deadline inside the
 * window the service honours it for, so a re-send of a committed write is
 * discarded (record 6); and a strongly consistent read-back that turns a write
 * whose outcome was lost into one of three verdicts. Whether a write needs the
 * token is the payload descriptor's question, answered here once.
 */

import { randomUUID } from 'node:crypto';

import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

import { nowMs } from '../clock';
import { type PayloadDescriptor, PayloadLocation, type DescriptorRef } from '../codec/codec';
import { classifyAwsError } from '../errors/classify';
import { ErrorCode } from '../errors/error-code';
import { conditionalCheckFailure } from './cancellation';
import type { DynamoDBDocumentLike, DocItem, TransactAction } from './client';
import { MAX_WRITE_LIFETIME_MS, withDynamoDBRetry, retryFor } from './retry';
import type { RetryOptions } from './retry';
import { PARTITION_KEY_ATTRIBUTE, type RowKey } from './table-schema';

/**
 * What a row write needs of its adapter: the document client, the table, and
 * the retry policy. Every context that writes or reads back a row already
 * carries these three, so a call site passes itself.
 */
export interface RowWriteDeps {
  client: DynamoDBDocumentLike;
  tableName: string;
  retry?: RetryOptions;
}

/** How one tokened transaction is retried, beyond the adapter's own policy. */
export interface TokenedWriteOptions {
  /** Cancels the retries. */
  signal?: AbortSignal;
  /** The jitter source, for a caller whose tests need the backoff to take no time. */
  rng?: () => number;
  /** The fewest attempts the write is given, whatever the adapter's policy says. */
  minAttempts?: number;
}

/** How one row write is sent: the guard it carries and the signal that cancels it. */
export interface RowWriteOptions {
  guard?: RevisionGuard;
  signal?: AbortSignal;
}

/**
 * Whether a payload descriptor names an S3 object, and so whether the write
 * carrying it can strand one.
 *
 * An inline payload references nothing outside its own row: a re-landed copy
 * of such a write is an ordinary last-write-wins outcome, not a lost object.
 * Only the offloaded write is worth the extra write capacity a transaction
 * costs, which is why the question is asked of the descriptor rather than of
 * the adapter — an adapter with an offloader configured still writes inline
 * whenever the payload is under its threshold.
 *
 * Accepts: `descriptor` — a full payload descriptor, or the projection a
 * pre-write read returns without the inline bytes.
 *
 * Returns: true when the payload was offloaded to S3.
 *
 * Throws: nothing.
 */
export function referencesS3Object(descriptor: DescriptorRef): boolean {
  return descriptor.location === PayloadLocation.S3;
}

/**
 * Commit `actions` as one
 * {@link https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html | TransactWriteItems}
 * under a client request token, so a re-send DynamoDB already applied lands as
 * a no-op instead of as a second write.
 *
 * A write that offloads its payload uploads the object first and commits the
 * row second. Lose the row's acknowledgement and the retry can commit it
 * twice; the cleanup that follows then releases an object the other attempt's
 * row still names, leaving a live row pointing at nothing. A delete has the
 * mirror problem: its retry, re-evaluated rather than deduplicated, meets a row
 * a competitor wrote after the first attempt landed and erases it. `PutItem`
 * and `DeleteItem` take no token and cannot be made to; a one-item transaction
 * can, and inside the service's 10-minute window the re-send is discarded
 * rather than applied.
 *
 * **What the token guarantees, and what it does not.** A write whose first
 * attempt **committed** is applied exactly once, at that moment — so a later
 * writer supersedes it normally and a concurrent delete stands. A write whose
 * first attempt was **rejected by its condition** carries no idempotency at
 * all: a cancelled transaction never completes, so DynamoDB caches no result
 * for its token, and a retry with the same token is a **fresh evaluation**
 * against the table as it stands at retry time. The short version — "a retried
 * write lands once" — is therefore false, and every caller that reasons about a
 * rejection must reason about the table, not about the token.
 *
 * Two readings that sentence must not be given, because the shorter version of
 * it invites both. It is about writes **this library sends with a token**: it
 * says nothing about a `BatchWriteItem`, which can carry no token at all, and
 * nothing about a first request that was already wrong, which no token can
 * help — a token makes a *re-sent* request harmless and has nothing to say
 * about a race that needs no retry to go wrong. And "exactly once" is about
 * **application, not ordering**: a cancelled-then-retried write applies later
 * than its first attempt, or not at all. What a cancellation does still
 * reserve is the token's *parameters*, which is why a re-pin must draw a fresh
 * one rather than re-present this one.
 *
 * **Stable across a re-send, fresh across a re-pin.** The input — token
 * included — is built once here, outside the retry closure, so every attempt
 * of one budget re-sends the identical request and the token deduplicates it.
 * A compare-and-swap that loses and re-pins calls this again and draws a new
 * token, which is required rather than merely tidy: the re-pinned request
 * carries a different `ConditionExpression`, and the same token presented with
 * changed parameters inside the window is refused with
 * `IdempotentParameterMismatchException` — a name that appears in no retry
 * list and in no handler in this package, so reusing a token would surface a
 * raw SDK error to a caller. That refusal is only observable against real
 * DynamoDB: the local image does not reserve a cancelled token's parameters
 * and simply re-evaluates the changed body, so the unit and integration tiers
 * can assert only that two re-pins carry different tokens, and the refusal
 * itself belongs to the tier that runs against AWS.
 *
 * **At most one guarded action, and only ever as many actions as must land
 * together.** A cancellation is read as a guard rejection only while exactly
 * one cause remains once the items along for the ride are set aside, so a
 * second *guarded* action whose condition fails in the same race would turn
 * that race into an unrecognised non-retryable error — which is exactly what a
 * competing writer of the same checkpoint id would produce, since it fails
 * both rows at once. Every row-at-a-time caller here
 * passes a single action for a second reason as well: a transaction cancels
 * whole, so one item per transaction keeps each write's outcome independent of
 * its neighbours', which is what the fan-out writers rely on. More than one
 * action is for the callers whose rows are atomic by contract and carry no
 * condition between them.
 *
 * Accepts: `deps` — the adapter's client, table and retry policy. `actions` —
 * the `Put`, `Delete`, `Update` or `ConditionCheck` entries to commit
 * together, captured by reference and re-sent unchanged on every attempt of
 * the budget, so a caller must mutate neither the array nor an entry of it while this call is in flight.
 * `options.signal` — aborts between attempts. `options.rng` — the jitter
 * source, replacing the default one for a caller whose tests need the backoff
 * to take no time. `options.minAttempts` — the fewest attempts the write is
 * given: the budget is the larger of it and the adapter's own `maxAttempts`,
 * so a caller policy may raise it, never lower it. Without `rng` and
 * `minAttempts` the retry receives the adapter's policy, the signal and the
 * deadline, and nothing else.
 *
 * Returns: nothing. The transaction committed, or it threw.
 *
 * Throws: whatever the transaction throws.
 *
 * Guarantees: the retrying stops while the token is still honoured. The budget
 * carries a deadline of {@link MAX_WRITE_LIFETIME_MS} from now, half the
 * window the service deduplicates over, so the wait that would carry this
 * write past it is never started.
 *
 * Nothing in the token enforces that window — the service honours a token for
 * `TOKEN_IDEMPOTENCY_WINDOW_MS` whatever the caller's policy says, and a
 * re-send arriving after it closes is a new request that is applied. The
 * deadline is what keeps the budget inside it, and it bounds only the waits
 * *between* attempts: it is tested before each backoff and cannot shorten an
 * attempt already in flight. On a client this library builds the per-attempt
 * `DEFAULT_REQUEST_TIMEOUT_MS` bounds that attempt as well; on an **injected**
 * client, which is used exactly as given and may carry no request timeout at
 * all, a single hung request can still carry the budget past the window, and
 * nothing here prevents it.
 *
 * That deadline is spread onto a copy of the policy and never assigned onto
 * it: `retryFor` hands back the adapter's own options object when there is no
 * signal, and stamping a deadline onto that object would bound every later
 * call of the same adapter by this call's clock.
 */
export async function transactIdempotently(
  deps: RowWriteDeps,
  actions: TransactAction[],
  options: TokenedWriteOptions = {},
): Promise<void> {
  const input = { TransactItems: actions, ClientRequestToken: randomUUID() };
  const deadlineAt = nowMs() + MAX_WRITE_LIFETIME_MS;
  await withDynamoDBRetry((request) => deps.client.transactWrite(input, request), {
    ...retryFor(deps, options.signal),
    ...(options.minAttempts === undefined
      ? {}
      : { maxAttempts: Math.max(options.minAttempts, deps.retry?.maxAttempts ?? 0) }),
    ...(options.rng === undefined ? {} : { rng: options.rng }),
    deadlineAt,
  });
}

/**
 * Commit one row under a request token; see {@link transactIdempotently} for
 * why the write takes a transaction's shape and what the token buys.
 *
 * Accepts: `deps` — the adapter's client, table and retry policy. `item` — the
 * row to commit. It is captured by reference and re-sent unchanged on every
 * attempt of the budget, so a caller must not mutate it while this call is in
 * flight: the re-send would carry the same token with different parameters,
 * which the service refuses with `IdempotentParameterMismatchException`.
 * `guard` — the condition fragments from `revisionGuard`, or a caller's own;
 * omitted writes unconditionally, which is the case a token helps most, since
 * nothing else stops a re-send from landing. `signal` — aborts between
 * attempts.
 *
 * Returns: nothing. The write committed, or it threw.
 *
 * Throws: whatever the transaction throws. A guard rejection now arrives as a
 * `TransactionCanceledException` whose single reason is `ConditionalCheckFailed`
 * rather than as a `ConditionalCheckFailedException`; both answer
 * `isConditionalCheckFailed` and both carry the rejected row to
 * `rejectedItem`, so a caller reads them the same way. A spent budget
 * throws `RETRY_EXHAUSTED` as any other call does.
 */
export async function putIdempotently(
  deps: RowWriteDeps,
  item: DocItem,
  guard?: RevisionGuard,
  signal?: AbortSignal,
): Promise<void> {
  await transactIdempotently(deps, [{ Put: { TableName: deps.tableName, Item: item, ...guard } }], {
    signal,
  });
}

/**
 * Remove one row under a request token; see {@link transactIdempotently} for
 * why the delete takes a transaction's shape and what the token buys.
 *
 * It buys more here than a put's token does. An unconditional `DeleteItem`
 * cannot be turned away, so a retry that arrives after the first attempt
 * already committed removes whatever a competitor has written since. Under a
 * token that replay is answered from the idempotency cache and never reaches
 * the row, which is what makes a condition failure *informative*: it now
 * proves a genuine race rather than possibly reporting this call's own
 * landed attempt.
 *
 * Accepts: `deps` — the adapter's client, table and retry policy. `key` — the
 * row's key, captured by reference and re-sent unchanged for the same reason a
 * put's item is. `guard` — the condition fragments pinning what the caller
 * observed; omitted deletes unconditionally. `signal` — aborts between
 * attempts.
 *
 * Returns: nothing. The delete committed, or it threw.
 *
 * Throws: as {@link putIdempotently} does. A rejection carries the row that
 * turned it away only while there is one — an absent row cancels with no
 * `Item` at all, which is how a caller tells "someone rewrote it" from "it was
 * already gone". **That reading is only sound while the guard asks for the
 * row.** Every guard `revisionGuard` builds carries
 * `ReturnValuesOnConditionCheckFailure: 'ALL_OLD'`; a caller passing its own
 * guard without it, or no guard at all, gets an empty rejection for a row that
 * is very much still there — and a caller that then releases what that row
 * names has deleted an object a live row points at.
 */
export async function deleteIdempotently(
  deps: RowWriteDeps,
  key: DocItem,
  guard?: RevisionGuard,
  signal?: AbortSignal,
): Promise<void> {
  await transactIdempotently(
    deps,
    [{ Delete: { TableName: deps.tableName, Key: key, ...guard } }],
    { signal },
  );
}

/**
 * Commit one row: as a tokened one-item transaction when it names an S3
 * object, and as a plain `PutItem` otherwise.
 *
 * The descriptor decides, not the adapter. An adapter with an offloader still
 * writes inline whenever a payload is under its threshold, and a row that names
 * no object has nothing a re-sent write could strand, so a transaction would
 * charge twice the write capacity to buy nothing.
 *
 * Accepts: `row` — the item to write. `payload` — its payload descriptor, which
 * decides the shape. `options.guard` — the condition the write carries, if any.
 * `options.signal` — cancels the retries.
 *
 * Returns: nothing, once the write committed.
 *
 * Throws: the guard's rejection — a rejection that `isConditionalCheckFailed`
 * answers true for, with the row that turned the write away readable through
 * `rejectedItem`; whatever the write throws once its retries are spent.
 */
export async function commitRow(
  deps: RowWriteDeps,
  row: DocItem,
  payload: DescriptorRef,
  options: RowWriteOptions = {},
): Promise<void> {
  if (referencesS3Object(payload)) {
    await putIdempotently(deps, row, options.guard, options.signal);
    return;
  }
  await withDynamoDBRetry(
    (request) =>
      deps.client.put({ TableName: deps.tableName, Item: row, ...options.guard }, request),
    retryFor(deps, options.signal),
  );
}

/**
 * Compare-and-swap attempts before a caller gives up and overwrites
 * unconditionally. Kept small on purpose: DynamoDB charges write capacity for a
 * *failed* conditional write too, sized on the existing item, so an aggressive
 * loop turns contention into cost. Three attempts settle every realistic race,
 * and the fallback is exactly the pre-0.9.0 behaviour rather than an error.
 */
export const OVERWRITE_CAS_MAX_ATTEMPTS = 3;

/** What a caller saw at the row before it tried to overwrite it. */
export interface ObservedRow {
  exists: boolean;
  revision?: string;
}

/**
 * Condition fragments to spread into a `PutCommand` input. Every guard asks
 * DynamoDB to attach the existing row to a rejection, so a compare-and-swap
 * that loses can re-pin from the exception (see {@link rejectedItem}) instead
 * of spending a second strongly-consistent read.
 */
export interface RevisionGuard {
  ConditionExpression: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, string>;
  ReturnValuesOnConditionCheckFailure: 'ALL_OLD';
}

const RETURN_REJECTED_ROW = { ReturnValuesOnConditionCheckFailure: 'ALL_OLD' } as const;

/**
 * Build the condition admitting a write only while the row still holds the
 * revision this caller observed.
 *
 * Without it, two concurrent overwrites both read the same previous payload
 * descriptor, both commit their own nonced upload, and both delete that same
 * previous object — leaving the loser's upload orphaned with nothing left
 * recording that it ever existed. A post-commit read-back cannot repair that,
 * because neither writer can learn of an object it never saw; only refusing the
 * second write until it re-reads can.
 *
 * A row with no revision attribute was written before 0.9.0. Pinning its
 * *absence* is what makes the swap correct across an upgrade: the first writer
 * to touch such a row stamps one, and any racer still holding the pre-upgrade
 * observation is turned away.
 *
 * Accepts: `attribute` — the revision attribute's name, since the checkpointer
 * reuses its `writeGroup` rather than carrying a second one. `observed` — the
 * three states a caller can have seen: no row, a row with no revision, a row
 * with one.
 *
 * Returns: the condition fragments for a `PutCommand`, one per state —
 * `attribute_not_exists(PK)`, `attribute_not_exists(<attribute>)`, and
 * equality. Every one asks DynamoDB to attach the existing row to a rejection,
 * so a swap that loses re-pins from the exception instead of spending a second
 * strongly-consistent read.
 *
 * Throws: nothing.
 *
 * Guarantees: it pins the revision the caller observed — a value, its absence,
 * or the row's own absence — and nothing else about the row. A revision is
 * drawn afresh by every write that replaces the row (`randomUUID()` for a
 * store record, the call's own `writeGroup` for a special row) and nothing
 * restores a spent one, so a **satisfied** guard proves that nothing replaced
 * the row between the caller's read and this write: the row overwritten is the
 * row observed, still naming the descriptor the caller read off it. That is
 * what makes it safe to release the payload this write superseded — the
 * caller is holding the descriptor the row really named, not a stale copy of
 * one a racer has already replaced and released. An update that leaves the
 * revision alone can still have touched the row in between — the recency-index
 * backfill is the one such write in this package, and it adds index keys and
 * nothing else — so what the guard pins is the row's identity, not every byte
 * of it.
 *
 * A **rejected** guard proves the mirror and no more: the row is not the one
 * observed. It is never evidence that a competitor won, because a write whose
 * acknowledgement was lost can be turned away by the row it committed itself
 * — see {@link isConditionalCheckFailed} — and it carries no idempotency for a
 * retry either, since a rejected attempt commits nothing for a token to be
 * answered from.
 */
export function revisionGuard(attribute: string, observed: ObservedRow): RevisionGuard {
  if (!observed.exists)
    return {
      ...RETURN_REJECTED_ROW,
      ConditionExpression: `attribute_not_exists(${PARTITION_KEY_ATTRIBUTE})`,
    };
  if (observed.revision === undefined) {
    return {
      ...RETURN_REJECTED_ROW,
      ConditionExpression: 'attribute_not_exists(#rev)',
      ExpressionAttributeNames: { '#rev': attribute },
    };
  }
  return {
    ...RETURN_REJECTED_ROW,
    ConditionExpression: '#rev = :rev',
    ExpressionAttributeNames: { '#rev': attribute },
    ExpressionAttributeValues: { ':rev': observed.revision },
  };
}

/** The field a payload descriptor carries the id of the write that produced it in. */
export const WRITE_ID_ATTRIBUTE = 'writeId';

/**
 * Build the condition admitting a delete only while the row still carries the
 * per-write id the reader observed on it.
 *
 * A partition-wide delete reads a partition and then deletes what it saw. A row
 * rewritten in between was acknowledged to its writer and is erased anyway, and
 * the object it named is released — which this turns into a refusal the pass
 * reports instead. The id is the write's own, never recomputed from the row's
 * state, so nothing can restore it and no second writer can arrive at it.
 *
 * Accepts: `attribute` — the attribute the id lives on, top-level for a row
 * that carries one (a pending write's `writeGroup`, a session row's own id) and
 * the payload attribute otherwise. `id` — the id the read observed; a row
 * observed *without* one is deleted unconditionally rather than pinned, so this
 * is never called for it. `field` — the field inside the attribute, which turns
 * the condition into a document path over a descriptor; omitted for a
 * top-level pin.
 *
 * Returns: the condition fragments for a `DeleteCommand`, asking DynamoDB to
 * attach the existing row to a rejection so the refusal can be told from a row
 * that was already gone with no second read.
 *
 * Throws: nothing.
 *
 * Guarantees: one equality and nothing else. A document path over an attribute
 * that is absent, or present without the field, evaluates false rather than
 * failing the request, so one shape covers an offloaded row, an inline one and
 * a row a racer has rewritten into either.
 *
 * What a satisfied guard proves is the delete's counterpart of
 * {@link revisionGuard}'s: the row removed is the row the partition read saw,
 * not a replacement a later write left at the same key — which is what makes
 * the object that read recorded against it the right one to release. A
 * rejection means the row now carries some other write's id, and this pass
 * leaves it in place and reports it rather than re-pinning, because a row it
 * never read is not its to delete.
 */
export function writeIdGuard(attribute: string, id: string, field?: string): RevisionGuard {
  const names: Record<string, string> = { '#pin': attribute };
  if (field !== undefined) names['#field'] = field;
  return {
    ...RETURN_REJECTED_ROW,
    ConditionExpression: field === undefined ? '#pin = :pin' : '#pin.#field = :pin',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: { ':pin': id },
  };
}

/**
 * Whether a conditional write was turned away by its guard.
 *
 * The same rejection has two shapes, because a `PutItem` reports it as an
 * exception of its own while a `TransactWriteItems` reports it as one
 * cancellation reason among one per item. Both are the same event to a caller,
 * so both answer true here and neither is a caller's business to tell apart.
 *
 * Accepts: `error` — any error; the exception's name and, for a cancelled
 * transaction, its reasons are read.
 *
 * Returns: true for `ConditionalCheckFailedException`, and for a cancellation
 * whose one cause is a `ConditionalCheckFailed` reason, as the classifier
 * decides both.
 *
 * Throws: nothing.
 *
 * Guarantees: **not** evidence that a competitor won. A `PutCommand` retried
 * after its response was lost can re-hit the row it wrote itself and fail
 * identically, and the two are indistinguishable from the rejection alone —
 * which is why every caller reads the row back before deleting anything.
 */
export function isConditionalCheckFailed(error: Error): boolean {
  return classifyAwsError(error) === ErrorCode.CONDITION_CONFLICT;
}

/**
 * The row that turned a conditional write away, when DynamoDB attached it
 * (`ReturnValuesOnConditionCheckFailure: 'ALL_OLD'`). Verified against real
 * DynamoDB: the document client does not unmarshall an *error* payload the way
 * it unmarshalls a response, so the item arrives in raw AttributeValue form and
 * is unmarshalled here. Undefined when the rejection carries no item — the row
 * was deleted between the observation and the write — in which case the caller
 * falls back to a read.
 *
 * A cancelled transaction attaches the same row to the cancellation reason of
 * the item whose condition failed, rather than to the error itself, and leaves
 * it in the same raw form — so there is one place more to look and still one
 * unmarshalling.
 *
 * Accepts: `error` — any error; only a rejection from a guard built by
 * {@link revisionGuard} carries the item.
 *
 * Returns: the row as a plain document, or undefined.
 *
 * Throws: whatever `unmarshall` rejects for an item that is not in
 * AttributeValue form.
 */
export function rejectedItem(error: Error): DocItem | undefined {
  const attached = (error as { Item?: Record<string, AttributeValue> }).Item;
  const raw = attached ?? conditionalCheckFailure(error)?.Item;
  return raw === undefined ? undefined : (unmarshall(raw) as DocItem);
}

/**
 * What a post-failure read established about a write whose outcome was
 * ambiguous.
 *
 * - `'landed'` — the row holds this write, so it committed server-side and only
 *   its acknowledgement was lost.
 * - `'not-landed'` — the row was read and holds something else, or nothing, so
 *   this write's own upload is dead and safe to release.
 * - `'unverified'` — the read itself failed, so nothing is established.
 *
 * The third answer is the one that must exist. Folding it into the second made
 * a partition that blocked both the write and this read delete the object a
 * possibly-live row points at, breaking every later read of that item. Leaking
 * one object is recoverable; stranding a live row is not.
 */
export type WriteVerdict = 'landed' | 'not-landed' | 'unverified';

/** Which row to read, and which attributes of it to project. */
export interface RowRead {
  key: { PK: string; SK: string };
  /** The attribute carrying the row's identity; always projected. */
  attribute: string;
  /** Further attributes to project, when the caller needs the row itself back. */
  also?: readonly string[];
  /**
   * Attributes holding a payload descriptor, projected as its `location` and
   * `s3Key` only. A cleanup decision needs where the payload lives, never its
   * inline bytes, which can run to hundreds of kilobytes. An attribute named
   * here and as `attribute` or in `also` is projected once, as the descriptor,
   * because DynamoDB refuses two overlapping paths in one projection.
   */
  descriptors?: readonly string[];
}

/**
 * A read, plus what makes the row *this* write's row.
 *
 * `expected` is the string the row must yield. `undefined` means there is
 * nothing to compare — a record with no revision, a checkpoint with nothing
 * offloaded — and no read is spent: with nothing at stake the answer is
 * `'not-landed'`, which releases nothing that exists.
 */
export interface RowProbe extends RowRead {
  /**
   * How the row names the write that holds it: `'attribute'` reads the
   * identity straight out of `attribute`, `'descriptor'` reads the S3 key of
   * the payload descriptor stored there.
   */
  kind: 'attribute' | 'descriptor';
  expected: string | undefined;
}

/** A verification read: what it established, and the row it saw. */
export interface VerifiedWrite {
  verdict: WriteVerdict;
  /** The row as read. Absent when nothing was read, or no row exists. */
  row?: DocItem;
}

/**
 * The S3 key an offloaded descriptor points at.
 *
 * Accepts: any descriptor, or none.
 *
 * Returns: the key, or undefined for an inline or absent payload — "this row
 * names no object", which is what a caller comparing two writes needs.
 *
 * Throws: nothing.
 */
export function offloadedKey(descriptor: PayloadDescriptor | undefined): string | undefined {
  return descriptor?.location === PayloadLocation.S3 ? descriptor.s3Key : undefined;
}

/**
 * The identity `row` carries under `probe`.
 *
 * Accepts: `probe.kind` — `'attribute'` reads the identity straight out of the
 * attribute, `'descriptor'` reads the S3 key of the descriptor stored there.
 * `row` — as read, or undefined when there is none.
 *
 * Returns: the identity, or undefined when the row is absent or carries none.
 *
 * Throws: nothing.
 */
export function identityOf(probe: RowProbe, row: DocItem | undefined): string | undefined {
  const stored = row?.[probe.attribute];
  if (probe.kind === 'attribute') return stored as string | undefined;
  return offloadedKey(stored as PayloadDescriptor | undefined);
}

/**
 * The verdict for a row already in hand.
 *
 * Accepts: `row` — the row a conditional-write rejection carried back, which
 * makes this verdict cost no read at all.
 *
 * Returns: `'landed'` when the row's identity is this write's, `'not-landed'`
 * otherwise. Never `'unverified'`: the row was seen.
 *
 * Throws: nothing.
 */
export function verdictFor(probe: RowProbe, row: DocItem | undefined): WriteVerdict {
  return identityOf(probe, row) === probe.expected ? 'landed' : 'not-landed';
}

/**
 * The projection for `read`, with no attribute name left unused, which DynamoDB
 * also refuses.
 */
function projectionOf(read: RowRead): { expression: string; names: Record<string, string> } {
  const nested = read.descriptors ?? [];
  const whole = [read.attribute, ...(read.also ?? [])].filter((name) => !nested.includes(name));
  const names: Record<string, string> = {};
  const paths: string[] = [];
  whole.forEach((name, index) => {
    names[`#a${index}`] = name;
    paths.push(`#a${index}`);
  });
  nested.forEach((name, index) => {
    names[`#d${index}`] = name;
    paths.push(`#d${index}.#loc`, `#d${index}.#s3k`);
  });
  if (nested.length > 0) Object.assign(names, { '#loc': 'location', '#s3k': 's3Key' });
  return { expression: paths.join(', '), names };
}

/**
 * Read the row a probe names, strongly consistently.
 *
 * Accepts: `read.attribute` — always projected. `read.also` — further
 * attributes, for a caller that needs the row itself back rather than only its
 * identity. `read.descriptors` — descriptor attributes, projected as their
 * `location` and `s3Key` only; each still comes back under its own name, as a
 * map holding those two.
 *
 * Returns: the projected row, or undefined when there is none.
 *
 * Throws: the underlying error, which {@link verifyRow} turns into a verdict
 * and a caller that wants the cause keeps. The two are separate functions
 * because a synthetic error built from a caught one lost the original cause.
 *
 * Guarantees: strongly consistent — a read that may lag is no evidence at all
 * about a write that may have landed.
 */
export async function readRow(deps: RowWriteDeps, read: RowRead): Promise<DocItem | undefined> {
  const { expression, names } = projectionOf(read);
  const result = await withDynamoDBRetry(
    (request) =>
      deps.client.get(
        {
          TableName: deps.tableName,
          Key: read.key,
          ConsistentRead: true,
          ProjectionExpression: expression,
          ExpressionAttributeNames: names,
        },
        request,
      ),
    deps.retry,
  );
  return result.Item as DocItem | undefined;
}

/**
 * Read one row back to establish what an ambiguous write actually did.
 *
 * No failure is proof of a non-commit: `withDynamoDBRetry` re-issues a write
 * whose response was lost, and those re-issues can time out at the transport
 * without reaching DynamoDB, so the budget is spent on a `RETRY_EXHAUSTED` error
 * while the row is live. Every caller that is about to delete something on the
 * strength of a failure reads the row first, through here.
 *
 * Accepts: `probe.expected` — the identity that would prove the write landed.
 * `undefined` means there is nothing at stake — a record with no revision, a
 * checkpoint with nothing offloaded — and no read is spent.
 *
 * Returns: the verdict and, when one was read, the row. See
 * {@link WriteVerdict} for what each answer licenses the caller to do.
 *
 * Throws: nothing. A failed read is the `'unverified'` answer, not an error:
 * the caller is already handling a failure and needs a decision, not a second
 * one.
 */
export async function verifyRow(deps: RowWriteDeps, probe: RowProbe): Promise<VerifiedWrite> {
  if (probe.expected === undefined) return { verdict: 'not-landed' };
  try {
    const row = await readRow(deps, probe);
    return { verdict: verdictFor(probe, row), row };
  } catch {
    return { verdict: 'unverified' };
  }
}

/**
 * Whether a row is confirmed absent right now — what resolves an ambiguous
 * retry-exhausted *delete*, where the delete may well have landed server-side
 * and only its acknowledgement was lost. Only the partition key is projected:
 * existence is the whole question.
 *
 * Accepts: `key` — the row's.
 *
 * Returns: `true` only when a strongly consistent read found no row; `false`
 * when it found one or when the read itself failed, because a failed read
 * confirms nothing — "not confirmed", never "still there": the caller only
 * rethrows on `false`, so nothing is deleted on the strength of a read that
 * did not happen.
 *
 * Throws: nothing.
 */
export async function isRowAbsent(deps: RowWriteDeps, key: RowKey): Promise<boolean> {
  try {
    return (await readRow(deps, { key, attribute: PARTITION_KEY_ATTRIBUTE })) === undefined;
  } catch {
    return false;
  }
}
