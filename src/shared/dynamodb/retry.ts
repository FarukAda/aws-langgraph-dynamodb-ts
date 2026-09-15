import {
  DEFAULT_RETRY_MAX_ATTEMPTS,
  INITIAL_BACKOFF_DELAY_MS,
  MAX_BACKOFF_DELAY_MS,
} from '../constants';
import { RetryExhaustedError } from '../errors/errors';
import { toError } from '../errors/wrap-error';
import { redactedMessage } from '../logging/secret-patterns';
import { abortErrorFrom } from './abort';
import { fullJitter, sleep } from './backoff';
import { DEFAULT_RETRYABLE_ERRORS, isRetryableError } from './retry-classifier';

/** What {@link RetryOptions.onRetry} learns before each backoff sleep. */
export interface RetryAttemptInfo {
  attempt: number;
  delayMs: number;
  error: Error;
}

/** Options controlling {@link withRetry}. */
export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableErrors?: readonly string[];
  /**
   * Decides retryability instead of `retryableErrors`, so a call site can
   * share one classifier (see `isTransientS3Error`) with paths that do not
   * go through `withRetry`.
   */
  isRetryable?: (error: Error) => boolean;
  /** Called before every backoff sleep, so retries are visible before the budget is exhausted. */
  onRetry?: (info: RetryAttemptInfo) => void;
  signal?: AbortSignal;
  rng?: () => number;
}

function delayForAttempt(attempt: number, base: number, max: number, rng: () => number): number {
  const exponential = base * 2 ** (attempt - 1);
  return fullJitter(Math.min(exponential, max), rng);
}

interface ResolvedRetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  isRetryable: (error: Error) => boolean;
  rng: () => number;
}

/** Apply defaults to {@link RetryOptions}. */
function resolveRetryOptions(options: RetryOptions): ResolvedRetryOptions {
  return {
    maxAttempts: options.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS,
    baseDelayMs: options.baseDelayMs ?? INITIAL_BACKOFF_DELAY_MS,
    maxDelayMs: options.maxDelayMs ?? MAX_BACKOFF_DELAY_MS,
    isRetryable:
      options.isRetryable ??
      ((error) => isRetryableError(error, options.retryableErrors ?? DEFAULT_RETRYABLE_ERRORS)),
    rng: options.rng ?? Math.random,
  };
}

/**
 * Run `fn`, retrying transient failures with full-jitter exponential backoff.
 *
 * Accepts: `options.maxAttempts` — total attempts including the first, default
 * {@link DEFAULT_RETRY_MAX_ATTEMPTS}; at least 1, which `validateRetryPolicy`
 * enforces for every caller-supplied policy. `options.baseDelayMs` /
 * `maxDelayMs` — the backoff schedule. `options.isRetryable` — replaces
 * `retryableErrors` entirely, so a call site can share one classifier with
 * paths that do not go through here. `options.signal` — checked once before
 * the first attempt and again during every backoff wait. `options.onRetry` —
 * called synchronously before each wait; an exception from it is not caught
 * and ends the operation.
 *
 * Returns: whatever `fn` resolves to, from the first attempt that succeeds.
 *
 * Throws: the error itself, unchanged, when it is not retryable — a
 * `ValidationException` or a permission failure is never retried;
 * {@link AbortError} when the signal fires, including during a wait;
 * {@link RetryExhaustedError} once the attempts are spent, carrying the attempt
 * count and the last error as `cause`. Its message quotes the last error
 * **redacted**, because it reaches `err.message`, which an application may
 * print without a redacting logger.
 *
 * Guarantees: `fn` is called at least once and at most `maxAttempts` times. A
 * thrown non-`Error` is wrapped, so what a caller catches is always an `Error`.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, isRetryable, rng } = resolveRetryOptions(options);

  if (options.signal?.aborted) throw abortErrorFrom(options.signal);

  let lastError: Error = new Error('Retry failed without error');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = toError(error as Error);
      if (!isRetryable(lastError)) throw lastError;
      if (attempt === maxAttempts) break;
      const delayMs = delayForAttempt(attempt, baseDelayMs, maxDelayMs, rng);
      options.onRetry?.({ attempt, delayMs, error: lastError });
      await sleep(delayMs, options.signal);
    }
  }
  throw new RetryExhaustedError(
    `Operation failed after ${maxAttempts} attempts: ${redactedMessage(lastError)}`,
    maxAttempts,
    lastError,
  );
}

/**
 * {@link withRetry} with this package's DynamoDB defaults.
 *
 * Accepts: `overrides` — merged over `maxAttempts:`
 * {@link DEFAULT_RETRY_MAX_ATTEMPTS}, so an adapter's resolved policy wins.
 *
 * Returns: as {@link withRetry}.
 *
 * Throws: as {@link withRetry}.
 */
export async function withDynamoDBRetry<T>(
  fn: () => Promise<T>,
  overrides?: Partial<RetryOptions>,
): Promise<T> {
  return withRetry(fn, { maxAttempts: DEFAULT_RETRY_MAX_ATTEMPTS, ...overrides });
}
