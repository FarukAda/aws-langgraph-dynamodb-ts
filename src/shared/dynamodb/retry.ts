import { nowMs } from '../clock';
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
  /**
   * @internal Absolute epoch milliseconds past which no further backoff sleep
   * is started, bounding a whole budget rather than a single attempt. Set per
   * call by the paths that carry a client request token, so the retrying ends
   * while that token still deduplicates a re-send; never a caller's option,
   * and absent it nothing about the schedule or the outcome changes.
   */
  deadlineAt?: number;
}

/**
 * Whether sleeping `delayMs` now would carry the budget past `deadlineAt`.
 * No deadline, no bound: the schedule is then exactly what it always was.
 */
function crossesDeadline(deadlineAt: number | undefined, delayMs: number): boolean {
  return deadlineAt !== undefined && nowMs() + delayMs >= deadlineAt;
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
 * and ends the operation. `options.deadlineAt` — an internal bound on the
 * whole budget rather than on one attempt: the wait that would carry the
 * operation past it is never started, and the budget ends there instead.
 * Without it the schedule, the attempt count and every error are unchanged.
 *
 * Returns: whatever `fn` resolves to, from the first attempt that succeeds.
 *
 * Throws: the error itself, unchanged, when it is not retryable — a
 * `ValidationException` or a permission failure is never retried;
 * {@link AbortError} when the signal fires, including during a wait;
 * {@link RetryExhaustedError} once the budget ends, carrying the attempt
 * actually reached — not the attempts configured — and the last error as
 * `cause`. Its message quotes the last error **redacted**, because it reaches
 * `err.message`, which an application may print without a redacting logger.
 *
 * A deadline that ends the budget is reported exactly as a spent one, by the
 * same error with the same code: a caller cannot tell the two apart, and
 * nothing needs to, since the handling of both is identical — read the row
 * back, and release only what is confirmed not to have landed.
 *
 * A cancelled wait is also an abort no longer observed. The signal is read
 * before the first attempt and thereafter only inside each wait, so ending the
 * budget in place of a wait drops that one observation point: a signal that
 * would have fired during exactly that wait surfaces as
 * {@link RetryExhaustedError} rather than {@link AbortError}. One already set
 * at entry, or fired during an earlier wait, is still caught.
 *
 * Guarantees: `fn` is called at least once and at most `maxAttempts` times. A
 * thrown non-`Error` is wrapped, so what a caller catches is always an `Error`.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, isRetryable, rng } = resolveRetryOptions(options);

  if (options.signal?.aborted) throw abortErrorFrom(options.signal);

  let lastError: Error = new Error('Retry failed without error');
  let attempts = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    try {
      return await fn();
    } catch (error) {
      lastError = toError(error as Error);
      if (!isRetryable(lastError)) throw lastError;
      if (attempt === maxAttempts) break;
      const delayMs = delayForAttempt(attempt, baseDelayMs, maxDelayMs, rng);
      if (crossesDeadline(options.deadlineAt, delayMs)) break;
      options.onRetry?.({ attempt, delayMs, error: lastError });
      await sleep(delayMs, options.signal);
    }
  }
  throw new RetryExhaustedError(
    `Operation failed after ${attempts} attempts: ${redactedMessage(lastError)}`,
    attempts,
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
