import {
  DEFAULT_RETRY_MAX_ATTEMPTS,
  INITIAL_BACKOFF_DELAY_MS,
  MAX_BACKOFF_DELAY_MS,
} from '../constants';
import { AbortError, RetryExhaustedError } from '../errors/errors';
import { toError } from '../errors/wrap-error';
import { redactedMessage } from '../logging/secret-patterns';
import { fullJitter, sleep } from './backoff';
import { DEFAULT_RETRYABLE_ERRORS, isRetryableError } from './retry-classifier';

/** Options controlling {@link withRetry}. */
export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableErrors?: readonly string[];
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
  retryable: readonly string[];
  rng: () => number;
}

/** Apply defaults to {@link RetryOptions}. */
function resolveRetryOptions(options: RetryOptions): ResolvedRetryOptions {
  return {
    maxAttempts: options.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS,
    baseDelayMs: options.baseDelayMs ?? INITIAL_BACKOFF_DELAY_MS,
    maxDelayMs: options.maxDelayMs ?? MAX_BACKOFF_DELAY_MS,
    retryable: options.retryableErrors ?? DEFAULT_RETRYABLE_ERRORS,
    rng: options.rng ?? Math.random,
  };
}

/**
 * Run `fn`, retrying retryable transient errors with full-jitter exponential
 * backoff. Non-retryable errors are re-thrown unchanged; exhaustion throws
 * {@link RetryExhaustedError}; an aborted signal throws {@link AbortError}.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxAttempts, baseDelayMs, maxDelayMs, retryable, rng } = resolveRetryOptions(options);

  if (options.signal?.aborted) throw new AbortError();

  let lastError: Error = new Error('Retry failed without error');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = toError(error as Error);
      if (!isRetryableError(lastError, retryable)) throw lastError;
      if (attempt === maxAttempts) break;
      await sleep(delayForAttempt(attempt, baseDelayMs, maxDelayMs, rng), options.signal);
    }
  }
  throw new RetryExhaustedError(
    `Operation failed after ${maxAttempts} attempts: ${redactedMessage(lastError)}`,
    maxAttempts,
    lastError,
  );
}

/** {@link withRetry} preset for DynamoDB operations. */
export async function withDynamoDBRetry<T>(
  fn: () => Promise<T>,
  overrides?: Partial<RetryOptions>,
): Promise<T> {
  return withRetry(fn, { maxAttempts: DEFAULT_RETRY_MAX_ATTEMPTS, ...overrides });
}
