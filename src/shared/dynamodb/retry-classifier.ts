import { getCancellationReasons } from './cancellation';

const MAX_CAUSE_DEPTH = 32;

/**
 * Default retryable transient signals. TransactionCanceledException is
 * intentionally absent (its reasons include permanent failures);
 * TransactionConflictException (transient row contention) IS retryable.
 */
export const DEFAULT_RETRYABLE_ERRORS: readonly string[] = [
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'RequestLimitExceeded',
  'InternalServerError',
  'ServiceUnavailable',
  'TransactionConflictException',
  'TransactionInProgressException',
  'RequestTimeout',
  'RequestTimeoutException',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'NetworkingError',
  'TimeoutError',
];

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
 * When `error` is a transaction cancellation carrying reasons, return whether
 * every reason is transient; otherwise undefined so normal signal matching
 * applies. A bare cancellation with no reasons is treated as non-retryable.
 */
function transactionCancellationRetryable(error: Error): boolean | undefined {
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

function collectSignals(error: Error): string[] {
  const seen = new WeakSet<object>();
  const signals: string[] = [];
  const walk = (node: Error, depth: number): void => {
    if (depth > MAX_CAUSE_DEPTH || node === null || typeof node !== 'object' || seen.has(node)) {
      return;
    }
    seen.add(node);
    const fields = node as {
      name?: string;
      code?: string;
      errno?: string;
      syscall?: string;
      cause?: Error;
    };
    for (const value of [fields.name, fields.code, fields.errno, fields.syscall]) {
      if (typeof value === 'string') signals.push(value);
    }
    if (fields.cause) walk(fields.cause, depth + 1);
  };
  walk(error, 0);
  return signals;
}

/** True when `error` (or any cause in its chain) matches a retryable signal. */
export function isRetryableError(error: Error, retryableErrors: readonly string[]): boolean {
  const cancellation = transactionCancellationRetryable(error);
  if (cancellation !== undefined) return cancellation;
  const signals = collectSignals(error);
  return signals.some((signal) => retryableErrors.some((retryable) => signal.includes(retryable)));
}
