import { randomUUID } from 'node:crypto';

import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

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

/**
 * Commit one row as a single-item
 * {@link https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html | TransactWriteItems}
 * under a client request token, so a re-send DynamoDB already applied lands as
 * a no-op instead of as a second write.
 *
 * A write that offloads its payload uploads the object first and commits the
 * row second. Lose the row's acknowledgement and the retry can commit it
 * twice; the cleanup that follows then releases an object the other attempt's
 * row still names, leaving a live row pointing at nothing. `PutItem` takes no
 * token and cannot be made to; a one-item transaction can, and inside the
 * service's 10-minute window the re-send is discarded rather than applied.
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
 * **One item, never more.** A cancellation is read as a guard rejection only
 * while exactly one cause remains once the items along for the ride are set
 * aside, so guarding a second item in the same transaction would turn a
 * genuine race into an unrecognised non-retryable error. Keeping one item per
 * transaction also keeps each write's outcome independent of its neighbours',
 * which is what the fan-out writers rely on.
 *
 * Accepts: `deps` — the adapter's client, table and retry policy. `item` — the
 * row to commit. It is captured by reference and re-sent unchanged on every
 * attempt of the budget, so a caller must not mutate it while this call is in
 * flight: the re-send would carry the same token with different parameters,
 * which the service refuses with `IdempotentParameterMismatchException`. `guard` — the condition fragments from
 * `revisionGuard`, or a caller's own; omitted writes unconditionally,
 * which is the case a token helps most, since nothing else stops a re-send
 * from landing. `signal` — aborts between attempts.
 *
 * Returns: nothing. The write committed, or it threw.
 *
 * Throws: whatever the transaction throws. A guard rejection now arrives as a
 * `TransactionCanceledException` whose single reason is `ConditionalCheckFailed`
 * rather than as a `ConditionalCheckFailedException`; both answer
 * `isConditionalCheckFailed` and both carry the rejected row to
 * `rejectedItem`, so a caller reads them the same way. A spent budget
 * throws `RetryExhaustedError` as any other call does.
 *
 * Guarantees: the retrying stops while the token is still honoured. The budget
 * carries a deadline of {@link MAX_WRITE_LIFETIME_MS} from now, half the
 * window the service deduplicates over, so the wait that would carry this
 * write past it is never started. That deadline is spread onto a copy of the
 * policy and never assigned onto it: `retryFor` hands back the adapter's own
 * options object when there is no signal, and stamping a deadline onto that
 * object would bound every later call of the same adapter by this call's
 * clock.
 */
export async function putIdempotently(
  deps: IdempotentWriteDeps,
  item: DocItem,
  guard?: RevisionGuard,
  signal?: AbortSignal,
): Promise<void> {
  const input = {
    TransactItems: [{ Put: { TableName: deps.tableName, Item: item, ...guard } }],
    ClientRequestToken: randomUUID(),
  };
  const deadlineAt = nowMs() + MAX_WRITE_LIFETIME_MS;
  await withDynamoDBRetry(() => deps.client.transactWrite(input), {
    ...retryFor(deps, signal),
    deadlineAt,
  });
}
