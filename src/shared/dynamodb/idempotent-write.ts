import { randomUUID } from 'node:crypto';

import type { DynamoDBDocument, TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';

import { nowMs } from '../clock';
import { PayloadLocation } from '../codec/codec';
import type { DescriptorRef } from '../codec/descriptor-keys';
import { MAX_WRITE_LIFETIME_MS } from '../constants';
import type { RevisionGuard } from './conditional-put';
import { withDynamoDBRetry } from './retry';
import type { RetryOptions } from './retry';
import { retryFor } from './retry-policy';
import type { DocItem } from './types';

/**
 * What one tokened write needs of its adapter: the document client, the table
 * and the resolved retry policy. Every context that writes a row already
 * carries these three, so a call site passes itself.
 */
export interface IdempotentWriteDeps {
  client: DynamoDBDocument;
  tableName: string;
  retry?: RetryOptions;
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

/** One action of a `TransactWriteItems`, as the document client takes it. */
type TransactAction = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

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
 * `signal` — aborts between attempts.
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
  deps: IdempotentWriteDeps,
  actions: TransactAction[],
  signal?: AbortSignal,
): Promise<void> {
  const input = { TransactItems: actions, ClientRequestToken: randomUUID() };
  const deadlineAt = nowMs() + MAX_WRITE_LIFETIME_MS;
  await withDynamoDBRetry(() => deps.client.transactWrite(input), {
    ...retryFor(deps, signal),
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
 * throws `RetryExhaustedError` as any other call does.
 */
export async function putIdempotently(
  deps: IdempotentWriteDeps,
  item: DocItem,
  guard?: RevisionGuard,
  signal?: AbortSignal,
): Promise<void> {
  await transactIdempotently(
    deps,
    [{ Put: { TableName: deps.tableName, Item: item, ...guard } }],
    signal,
  );
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
  deps: IdempotentWriteDeps,
  key: DocItem,
  guard?: RevisionGuard,
  signal?: AbortSignal,
): Promise<void> {
  await transactIdempotently(
    deps,
    [{ Delete: { TableName: deps.tableName, Key: key, ...guard } }],
    signal,
  );
}
