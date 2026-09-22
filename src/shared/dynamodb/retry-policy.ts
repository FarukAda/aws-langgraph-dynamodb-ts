import {
  DEFAULT_RETRY_MAX_ATTEMPTS,
  INITIAL_BACKOFF_DELAY_MS,
  MAX_BACKOFF_DELAY_MS,
  MAX_WRITE_LIFETIME_MS,
} from '../constants';
import type { Logger } from '../logging/logger';
import { truncateForLog } from '../logging/truncate';
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

/** A policy with every field defaulted, before the logger is attached to it. */
interface ResolvedPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

/**
 * The nominal worst case of a policy's backoff schedule, in milliseconds.
 *
 * `withRetry` sleeps *between* attempts, so a budget of `maxAttempts` attempts
 * holds `maxAttempts - 1` sleeps, and full jitter draws the k-th of them from
 * `[0, min(baseDelayMs * 2 ** (k - 1), maxDelayMs))`. The worst case is
 * therefore the **sum of those caps**:
 *
 * `sum over k in 1..maxAttempts-1 of min(baseDelayMs * 2 ** (k - 1), maxDelayMs)`
 *
 * It is stated here because the reading a reader reaches for —
 * `maxAttempts * maxDelayMs` — is wrong in both directions at once: it counts
 * a sleep after the final attempt, which never happens, and it charges the cap
 * for every early sleep the exponential has not yet climbed to. At the
 * defaults - five attempts, so four sleeps - they total 1.5 s where the naive
 * reading says 25 s.
 *
 * Nominal, not actual: each sleep is drawn uniformly below its cap, so a real
 * budget averages about half of this and only approaches it in the limit. The
 * cap is what a bound has to be measured against all the same.
 */
function nominalBudgetMs(policy: ResolvedPolicy): number {
  let total = 0;
  for (let sleep = 1; sleep < policy.maxAttempts; sleep++) {
    total += Math.min(policy.baseDelayMs * 2 ** (sleep - 1), policy.maxDelayMs);
  }
  return total;
}

/**
 * Warn when a policy's nominal budget outlives {@link MAX_WRITE_LIFETIME_MS},
 * the deadline every token-carrying write in this package runs under.
 *
 * Warn, never refuse. A long policy is the caller's own choice, it stays
 * legal, and the deadline already makes it safe — what it is not, without this
 * line, is visible: a deadline that ends a budget early and a budget that is
 * simply spent both surface as the same `RetryExhaustedError`, so the first
 * evidence that a configured policy can never run to its end would otherwise
 * be an incident. Said once, at construction, it is said before the first
 * write rather than after.
 */
function warnIfOutlivesWriteLifetime(policy: ResolvedPolicy, logger: Logger): void {
  const budgetMs = nominalBudgetMs(policy);
  if (budgetMs <= MAX_WRITE_LIFETIME_MS) return;
  logger.warn('retry policy outlives the write lifetime; the budget will be cut short', {
    budgetMs,
    maxWriteLifetimeMs: MAX_WRITE_LIFETIME_MS,
  });
}

/**
 * Resolve an adapter's retry policy once, at construction.
 *
 * Accepts: `policy` — the caller's, already validated, or nothing. `logger` —
 * the adapter's resolved logger.
 *
 * Returns: the options every DynamoDB call of that adapter uses, with each
 * field defaulted and the logger attached, so every retry is visible at `debug`
 * (the attempt, the delay about to be slept, the error's name) instead of only
 * surfacing once the budget is exhausted.
 *
 * Accepts: `attemptFloor` — the lowest attempt count this adapter will actually
 * use, when it raises a caller's below its own. The budget is warned about at
 * that number rather than at the caller's, because it is the one the writes
 * will really spend; an adapter that honours the caller's count passes none.
 *
 * Throws: nothing; the policy was validated where it was given. A policy whose
 * nominal budget outlives {@link MAX_WRITE_LIFETIME_MS} is warned about rather
 * than refused, once per adapter constructed — three adapters built from one
 * long policy each say so for themselves — see
 * {@link warnIfOutlivesWriteLifetime}. The defaults are far inside it and say
 * nothing.
 */
export function resolveRetryPolicy(
  policy: RetryPolicy | undefined,
  logger: Logger,
  attemptFloor = 0,
): RetryOptions {
  const resolved = {
    maxAttempts: policy?.maxAttempts ?? DEFAULT_RETRY_MAX_ATTEMPTS,
    baseDelayMs: policy?.baseDelayMs ?? INITIAL_BACKOFF_DELAY_MS,
    maxDelayMs: policy?.maxDelayMs ?? MAX_BACKOFF_DELAY_MS,
  };
  /**
   * Measured at the attempts the adapter will really make, not at the ones the
   * caller wrote. The history append raises a caller's count to its own floor
   * while keeping the caller's delays, so a policy that only raises
   * `maxDelayMs` produces a budget far past the deadline and would otherwise
   * be warned about nowhere. An adapter with no floor passes none.
   */
  warnIfOutlivesWriteLifetime(
    { ...resolved, maxAttempts: Math.max(resolved.maxAttempts, attemptFloor) },
    logger,
  );
  return {
    ...resolved,
    /**
     * The name, never the message — and bounded: the transient failure came
     * from the SDK, the transport or a caller's own collaborator, and nothing
     * this package ran checked how long its name is. This line fires once per
     * retry, so an unbounded one is paid for per attempt.
     */
    onRetry: ({ attempt, delayMs, error }) =>
      logger.debug('retrying after a transient error', {
        attempt,
        delayMs,
        error: truncateForLog(error.name),
      }),
  };
}

/**
 * The context's retry options plus a per-call cancellation signal.
 *
 * Accepts: `context.retry` — the adapter's resolved policy. `signal` — the
 * caller's, when the call takes one.
 *
 * Returns: the adapter's options untouched when there is no signal — the same
 * object, so no per-call allocation on the common path — and a copy carrying it
 * when there is.
 *
 * Throws: nothing.
 */
export function retryFor(
  context: { retry?: RetryOptions },
  signal?: AbortSignal,
): RetryOptions | undefined {
  return signal === undefined ? context.retry : { ...context.retry, signal };
}
