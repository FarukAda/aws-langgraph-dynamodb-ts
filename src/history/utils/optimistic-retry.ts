/**
 * Optimistic-concurrency retry helper shared by addMessage / addMessages.
 *
 * These actions read the current messageCount, then run a transaction that writes
 * new items and updates the counter with a ConditionExpression. On concurrent
 * modification the condition fails; we re-read and retry up to N times.
 */

export const MAX_OPTIMISTIC_RETRIES = 5;

/**
 * Returns true for errors that indicate an optimistic-lock conflict that is
 * safe to retry — either a bare `ConditionalCheckFailedException`, or a
 * `TransactionCanceledException` where every reported `CancellationReason` is
 * either `ConditionalCheckFailed` or `None`.
 *
 * DynamoDB's `CancellationReasons` array pairs 1:1 with the TransactItems it
 * was handed: participants that did not block the transaction report `None`.
 * Mixed-outcome cases — a `ConditionalCheckFailed` in item 0 alongside a
 * `ValidationError` or `ItemCollectionSizeLimitExceeded` in item 1 — are
 * permanent: retrying the whole transaction will never resolve the permanent
 * sub-reason, so we must propagate instead of looping.
 */
export function isConditionalCheckFailure(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { name?: string; CancellationReasons?: Array<{ Code?: string }> };
  if (e.name === 'ConditionalCheckFailedException') return true;
  if (e.name === 'TransactionCanceledException' && Array.isArray(e.CancellationReasons)) {
    const reasons = e.CancellationReasons;
    if (reasons.length === 0) return false;
    // Need at least one ConditionalCheckFailed (otherwise nothing suggests the
    // transaction will differ on retry) and no permanent sub-reason mixed in.
    let sawConditionalFailure = false;
    for (const r of reasons) {
      const code = r?.Code;
      if (code === 'ConditionalCheckFailed') {
        sawConditionalFailure = true;
      } else if (code && code !== 'None') {
        return false;
      }
    }
    return sawConditionalFailure;
  }
  return false;
}

/**
 * Run `fn` until it succeeds or until MAX_OPTIMISTIC_RETRIES attempts exhaust.
 *
 * - On conditional-check failure (any attempt but the last), `fn` is re-invoked.
 * - On any other error, the error is re-thrown immediately.
 * - On exhaustion, a labelled error is thrown so the caller can identify it.
 */
export async function withOptimisticRetry<T>(
  label: string,
  fn: (attempt: number) => Promise<T>,
): Promise<T> {
  for (let attempt = 0; attempt < MAX_OPTIMISTIC_RETRIES; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      // Non-retryable errors propagate immediately. Conditional-check failures
      // fall through to retry — and once the loop exhausts (including a failure
      // on the final attempt) we surface the labelled exhaustion error below so
      // the caller can distinguish "gave up after N races" from a one-off
      // conditional failure.
      if (!isConditionalCheckFailure(err)) {
        throw err;
      }
    }
  }
  throw new Error(`${label} failed after ${MAX_OPTIMISTIC_RETRIES} optimistic-lock retries`);
}
