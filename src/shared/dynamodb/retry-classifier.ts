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
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
];

/**
 * HTTP statuses the AWS SDK retries regardless of the error name: throttling
 * (429) and the transient server statuses. They matter most for an error the
 * SDK could not map to a modeled exception (an intermediary's HTML 503, a
 * truncated body), which arrives as `name: 'Unknown'` with only its status.
 */
const TRANSIENT_HTTP_STATUSES: readonly number[] = [429, 500, 502, 503, 504];

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

/** What the cause chain says about an error: exact signal tokens, HTTP statuses, retryable trait. */
interface RetryEvidence {
  signals: string[];
  statuses: number[];
  retryableByTrait: boolean;
}

interface ErrorFields {
  name?: string;
  code?: string;
  errno?: string;
  syscall?: string;
  cause?: Error;
  $metadata?: { httpStatusCode?: number };
  $retryable?: object;
}

/** Add one node's signal tokens, HTTP status and retryable trait to `evidence`. */
function recordNode(fields: ErrorFields, evidence: RetryEvidence): void {
  for (const value of [fields.name, fields.code, fields.errno, fields.syscall]) {
    if (typeof value === 'string') evidence.signals.push(value);
  }
  if (typeof fields.$metadata?.httpStatusCode === 'number') {
    evidence.statuses.push(fields.$metadata.httpStatusCode);
  }
  if (fields.$retryable !== undefined && fields.$retryable !== null)
    evidence.retryableByTrait = true;
}

function collectEvidence(error: Error): RetryEvidence {
  const seen = new WeakSet<object>();
  const evidence: RetryEvidence = { signals: [], statuses: [], retryableByTrait: false };
  const walk = (node: Error, depth: number): void => {
    if (depth > MAX_CAUSE_DEPTH || node === null || typeof node !== 'object' || seen.has(node)) {
      return;
    }
    seen.add(node);
    const fields = node as ErrorFields;
    recordNode(fields, evidence);
    if (fields.cause) walk(fields.cause, depth + 1);
  };
  walk(error, 0);
  return evidence;
}

/**
 * True when `error` (or any cause in its chain) is transient: a transaction
 * cancellation whose every reason is transient (that verdict takes precedence,
 * because a permanent reason arrives with the same statuses as a transient
 * one), an HTTP status in {@link TRANSIENT_HTTP_STATUSES}, the SDK's
 * `$retryable` trait, or an exact match of a `name`/`code`/`errno`/`syscall`
 * token against `retryableErrors`. Exact, not substring: the fields are
 * whole tokens, and a substring rule would let an unrelated name that merely
 * contains one ride along.
 */
export function isRetryableError(error: Error, retryableErrors: readonly string[]): boolean {
  const cancellation = transactionCancellationRetryable(error);
  if (cancellation !== undefined) return cancellation;
  const evidence = collectEvidence(error);
  if (evidence.retryableByTrait) return true;
  if (evidence.statuses.some((status) => TRANSIENT_HTTP_STATUSES.includes(status))) return true;
  return evidence.signals.some((signal) => retryableErrors.includes(signal));
}
