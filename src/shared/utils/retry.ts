/**
 * Retry utilities for handling transient DynamoDB errors
 * Shared between store and checkpointer
 */

import { sleep } from './sleep';

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableErrors?: string[];
  /**
   * Optional abort signal. When aborted, any in-flight sleep between retries
   * resolves immediately and `withRetry` rejects with the signal's abort reason.
   * The signal is checked before every attempt, so an abort mid-backoff short-
   * circuits the remaining retries rather than consuming the full schedule.
   */
  signal?: AbortSignal;
}

// TransactionCanceledException is NOT retried here: its CancellationReasons include
// permanent failures (ConditionalCheckFailed, ValidationError, ItemCollectionSizeLimitExceeded)
// that must not be retried blindly. Callers that need to retry on specific sub-reasons
// (e.g. ThrottlingError) must inspect CancellationReasons themselves.
//
// TransactionConflictException (the *transient* sibling — one row racing with another
// concurrent transaction) IS retried. It's the recommended retry path for writes under
// contention and is distinct from TransactionCanceledException.
const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'signal'>> = {
  maxAttempts: 5,
  baseDelayMs: 100,
  maxDelayMs: 5000,
  retryableErrors: [
    // DynamoDB throttling / capacity
    'ProvisionedThroughputExceededException',
    'ThrottlingException',
    'RequestLimitExceeded',
    // Service-side transient
    'InternalServerError',
    'ServiceUnavailable',
    // Transaction contention (transient — distinct from TransactionCanceledException)
    'TransactionConflictException',
    // Node-level network transients. Matched against both the error `code` and
    // `name` fields so we catch plain socket errors as well as SDK-wrapped ones.
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'EAI_AGAIN',
    'NetworkingError',
    'TimeoutError',
  ],
};

/**
 * Calculate delay with full jitter (AWS recommended) and a max-delay cap.
 *
 * `delay = random(0, min(cap, base * 2^(attempt-1)))` — spreads retries
 * uniformly across the backoff window so concurrent clients don't synchronize
 * into a thundering herd.
 * See https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 */
function calculateDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
  const cap = Math.min(exponentialDelay, maxDelayMs);
  return Math.random() * cap;
}

/**
 * Check if an error is retryable.
 *
 * Matches against the error's `name` and `code` fields (and, when available,
 * a nested `$metadata`/`cause`) so we catch AWS SDK exceptions, Node socket
 * errors (`ECONNRESET`, `ETIMEDOUT`, …), and wrapped `cause` chains.
 */
function isRetryableError(error: unknown, retryableErrors: string[]): boolean {
  if (!error) return false;

  const seen = new WeakSet<object>();
  const signals: string[] = [];

  // Bound recursion depth — WeakSet breaks cycles but does not bound unique chain
  // length. An attacker (or a buggy SDK middleware) could craft a 10k-deep
  // `cause` chain and stack-overflow the process. 32 is generous: realistic AWS
  // SDK wrapping nests 3-5 deep.
  const MAX_CAUSE_DEPTH = 32;

  const collect = (err: unknown, depth: number): void => {
    if (depth > MAX_CAUSE_DEPTH) return;
    if (!err || typeof err !== 'object') return;
    if (seen.has(err as object)) return;
    seen.add(err as object);

    const o = err as Record<string, unknown>;
    if (typeof o.name === 'string') signals.push(o.name);
    if (typeof o.code === 'string') signals.push(o.code);
    if (typeof o.errno === 'string') signals.push(o.errno);
    if (typeof o.syscall === 'string') signals.push(o.syscall);
    collect(o.cause, depth + 1);
  };

  collect(error, 0);

  if (signals.length === 0) return false;

  return retryableErrors.some((retryable) => signals.some((sig) => sig.includes(retryable)));
}

/**
 * Retry a function with exponential backoff
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { signal, ...rest } = options;
  const opts = { ...DEFAULT_OPTIONS, ...rest };
  let lastError: unknown;

  // Surface pre-aborted signals before consuming an attempt.
  if (signal?.aborted) {
    throw signal.reason ?? new Error('Aborted');
  }

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry if this is the last attempt
      if (attempt === opts.maxAttempts) {
        break;
      }

      // Don't retry if the error is not retryable
      if (!isRetryableError(error, opts.retryableErrors)) {
        // Convert to Error if needed, preserving properties
        // eslint-disable-next-line no-instanceof/no-instanceof
        if (error instanceof Error) {
          throw error;
        }
        const wrappedError = new Error(
          error && typeof error === 'object' && 'message' in error
            ? String((error as { message: unknown }).message)
            : String(error),
        );
        // Preserve name and other properties from the original error
        if (error && typeof error === 'object') {
          Object.assign(wrappedError, error);
        }
        throw wrappedError;
      }

      // Abort mid-backoff short-circuits the remaining retries — sleep() rejects
      // with the signal's reason, which we re-throw so the caller sees the abort
      // rather than the last retry error.
      const delay = calculateDelay(attempt, opts.baseDelayMs, opts.maxDelayMs);
      await sleep(delay, signal);
    }
  }

  // Ensure we always throw an Error object
  if (!lastError) {
    throw new Error('Retry failed without error');
  }
  // eslint-disable-next-line no-instanceof/no-instanceof
  if (lastError instanceof Error) {
    throw lastError;
  }
  // Convert to Error while preserving properties
  const wrappedError = new Error(
    lastError && typeof lastError === 'object' && 'message' in lastError
      ? String((lastError as { message: unknown }).message)
      : String(lastError),
  );
  if (lastError && typeof lastError === 'object') {
    Object.assign(wrappedError, lastError);
  }
  throw wrappedError;
}

/**
 * Specialized retry for DynamoDB operations
 */
export async function withDynamoDBRetry<T>(
  fn: () => Promise<T>,
  overrides?: Partial<RetryOptions>,
): Promise<T> {
  return withRetry(fn, {
    maxAttempts: 5,
    baseDelayMs: 100,
    maxDelayMs: 5000,
    ...overrides,
  });
}
