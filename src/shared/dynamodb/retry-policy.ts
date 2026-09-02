import {
  DEFAULT_RETRY_MAX_ATTEMPTS,
  INITIAL_BACKOFF_DELAY_MS,
  MAX_BACKOFF_DELAY_MS,
} from '../constants';
import type { Logger } from '../logging/logger';
import type { RetryOptions } from './retry';

/**
 * Caller-facing retry tunables for every DynamoDB call an adapter makes. The
 * schedule is full-jitter exponential backoff: `baseDelayMs` doubling per
 * attempt, capped at `maxDelayMs`, for `maxAttempts` attempts. The
 * message-append path never goes below its own contention floor.
 */
export interface RetryPolicy {
  /** Attempts per call before `RetryExhaustedError` (default 5). */
  maxAttempts?: number;
  /** First backoff delay in milliseconds (default 100). */
  baseDelayMs?: number;
  /** Cap on a single backoff delay in milliseconds (default 5000). */
  maxDelayMs?: number;
}

/**
 * Resolve an adapter's retry policy once, attaching the context logger so
 * every retry is visible at `debug` (attempt, the delay about to be slept, the
 * error name) instead of only surfacing once the budget is exhausted.
 */
export function resolveRetryPolicy(policy: RetryPolicy | undefined, logger: Logger): RetryOptions {
  return {
    maxAttempts: policy?.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS,
    baseDelayMs: policy?.baseDelayMs ?? INITIAL_BACKOFF_DELAY_MS,
    maxDelayMs: policy?.maxDelayMs ?? MAX_BACKOFF_DELAY_MS,
    onRetry: ({ attempt, delayMs, error }) =>
      logger.debug('retrying after a transient error', { attempt, delayMs, error: error.name }),
  };
}
