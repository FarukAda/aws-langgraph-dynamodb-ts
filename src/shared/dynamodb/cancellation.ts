import type { AttributeValue } from '@aws-sdk/client-dynamodb';

/**
 * One entry of a TransactWriteItems/TransactionCanceledException's
 * CancellationReasons. `Item` is the row the service attached to the item whose
 * condition failed, in raw AttributeValue form — an error payload is not
 * unmarshalled by the document client the way a response is.
 */
export interface CancellationReason {
  Code?: string;
  Item?: Record<string, AttributeValue>;
}

/**
 * The fields a write's rejection can arrive in: the exception's own name, and
 * the per-item reasons a cancelled transaction carries instead. Both are
 * optional because this is an arbitrary error seen through a reader's eyes — a
 * rejection outside a transaction names itself and carries no reasons, one
 * inside a transaction carries reasons under a name of its own.
 */
export interface RejectionFields {
  name?: string;
  CancellationReasons?: CancellationReason[];
}

/** The reason code an item that was not the cause carries. */
const NOT_THE_CAUSE = 'None';

/**
 * The reason code a guard rejection arrives under inside a transaction. It is
 * *not* the exception name the same rejection carries outside one
 * (`ConditionalCheckFailedException`); the two strings are neither
 * interchangeable nor prefixes to test for.
 */
const CONDITION_FAILED = 'ConditionalCheckFailed';

/**
 * The per-item reasons a `TransactWriteItems` cancellation carries.
 *
 * Accepts: `error` — any error; only a `TransactionCanceledException` carries
 * the field.
 *
 * Its parameter is the weak {@link RejectionFields} rather than `Error`, which
 * is a deliberate trade: `{}` and `{ name }` now compile where they did not,
 * and in exchange this module stays the only place that dereferences
 * `CancellationReasons`, so {@link conditionalCheckFailure}, the retry
 * classifier and the two history readers cannot drift apart in how they read
 * it. Every value that reaches it at runtime comes from a `catch`; the two
 * call sites inside this package that pass it along rather than an `Error`
 * ({@link conditionalCheckFailure} and `isConditionalCheckFailed`) received
 * one from a `catch` themselves.
 *
 * Returns: one entry per transaction item, in the order the items were sent
 * (https://docs.aws.amazon.com/amazondynamodb/latest/APIReference/API_TransactWriteItems.html),
 * or `undefined` when the error carries none — which is what an older service
 * response, a different failure, or a thrown value that is not an object at
 * all looks like.
 *
 * Throws: **nothing**, for any value a `throw` can produce. Every value that
 * reaches this came from a `catch`, and `null` is one a `catch` can bind: the
 * property read raised a `TypeError` there, inside the classification the
 * retry layer makes before it decides whether to try again.
 */
export function getCancellationReasons(error: RejectionFields): CancellationReason[] | undefined {
  return (error as RejectionFields | undefined)?.CancellationReasons;
}

/**
 * The reason belonging to the one item a transaction's guard turned away.
 *
 * A cancellation names every item, so "was this write rejected by its
 * condition?" is only answerable once the items that were merely along for the
 * ride are set aside. What must remain is a single cause, and it must be the
 * condition: a cancellation that also failed a second item for its own reason
 * is not a guard rejection, and reporting one would hide the other failure.
 *
 * A reason carrying no `Code` counts as a cause here, while the retry
 * classifier treats that same shape as transient. The disagreement is
 * deliberate, because the two readers are conservative in opposite directions:
 * for the classifier, an unreadable reason may be retried, which a request
 * token makes harmless; here it must **not** be read as a clean rejection,
 * since acting on one discards whatever else the transaction failed on. AWS
 * populates `Code` for every item, so neither branch is reachable in practice.
 *
 * Accepts: `error` — any error; only a cancellation carries reasons.
 *
 * Returns: the sole `ConditionalCheckFailed` reason — with the rejected row
 * attached when the item asked for it — or `undefined` for every other error,
 * including a cancellation with no reasons, a different cause, or more than
 * one.
 *
 * Throws: nothing.
 */
export function conditionalCheckFailure(error: RejectionFields): CancellationReason | undefined {
  const reasons = getCancellationReasons(error) ?? [];
  const causes = reasons.filter((reason) => reason.Code !== NOT_THE_CAUSE);
  return causes.length === 1 && causes[0].Code === CONDITION_FAILED ? causes[0] : undefined;
}

/**
 * Cancellation reason codes (from a `TransactionCanceledException`'s
 * `CancellationReasons`) that are transient and safe to retry. `None` marks an
 * item that was not the cause and is ignored.
 */
const TRANSIENT_CANCELLATION_REASONS: readonly string[] = [
  'None',
  'TransactionConflict',
  'ThrottlingError',
  'ProvisionedThroughputExceeded',
];

/**
 * Whether a cancelled transaction failed only for transient reasons.
 *
 * Accepts: `error` — any error; only a cancellation carries reasons.
 *
 * Returns: `undefined` when the error carries no reasons, so the caller's
 * ordinary signal matching applies; otherwise whether every reason is
 * transient. A cancellation carrying no reasons at all is not transient.
 *
 * Throws: nothing, for any value; see {@link getCancellationReasons}.
 */
export function transientCancellation(error: RejectionFields): boolean | undefined {
  const reasons = getCancellationReasons(error);
  if (!reasons) return undefined;
  /**
   * `length > 0` is load-bearing: `.every()` is vacuously true on an empty
   * array, which would make a reason-less cancellation retryable — the exact
   * opposite of what this function documents. AWS populates one reason per
   * `TransactItems` entry, so an empty array should not occur; if it ever
   * does, the conservative answer is not to retry.
   */
  return (
    reasons.length > 0 &&
    reasons.every(
      (reason) => reason.Code === undefined || TRANSIENT_CANCELLATION_REASONS.includes(reason.Code),
    )
  );
}

/** Cancellation reason codes that mean the request was throttled. */
const THROTTLING_REASONS: readonly string[] = ['ThrottlingError', 'ProvisionedThroughputExceeded'];

/**
 * Whether a cancelled transaction was throttled.
 *
 * Accepts: `error` — any error; only a cancellation carries reasons.
 *
 * Returns: true when any reason is a throttling reason. Meaningful only for a
 * cancellation {@link transientCancellation} already found transient, which is
 * the one place it is asked.
 *
 * Throws: nothing, for any value.
 */
export function throttledCancellation(error: RejectionFields): boolean {
  return (getCancellationReasons(error) ?? []).some(
    (reason) => reason.Code !== undefined && THROTTLING_REASONS.includes(reason.Code),
  );
}

/**
 * Whether the item at `index` of a cancelled transaction failed its condition.
 *
 * Accepts: `error` — any error. `index` — the item's position in the
 * `TransactItems` the caller sent; reasons come back in that order.
 *
 * Returns: true when that item's reason is `ConditionalCheckFailed`, whatever
 * the other items' reasons are; false for anything that is not such a
 * cancellation.
 *
 * Throws: nothing, for any value.
 */
export function conditionFailedAt(error: RejectionFields, index: number): boolean {
  return getCancellationReasons(error)?.[index]?.Code === CONDITION_FAILED;
}
