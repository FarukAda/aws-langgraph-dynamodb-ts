/**
 * Backoff helper shared by the UnprocessedItems / UnprocessedKeys retry loops
 * in batch-write and BatchGetItem paths. Centralized so both call sites use
 * the same cap, growth, and sleep semantics.
 */

const DEFAULT_INITIAL_DELAY_MS = 100;
const DEFAULT_MAX_DELAY_MS = 5000;

/**
 * Sleep for `ms` milliseconds, optionally cancellable via an `AbortSignal`.
 *
 * If `signal` is already aborted the returned promise rejects synchronously with
 * the signal's abort reason. Otherwise the timer resolves on the normal path and
 * the abort listener is removed to avoid leaking handlers.
 *
 * The `settled` flag is a belt-and-braces guard: `{ once: true }` already
 * prevents the listener from firing twice, but the guard also ensures we never
 * resolve *and* reject (which would produce an unhandled rejection if the timer
 * and abort event fire in the same microtask turn).
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new Error('Aborted'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Exponential-backoff delay calculator. Given the *previous* delay, returns the
 * next delay — double it, capped at `max`. Use with {@link sleep} and
 * {@link fullJitter} so concurrent retriers don't synchronize.
 *
 *   let delay = INITIAL_DELAY_MS;
 *   while (keep_going) {
 *     await sleep(fullJitter(delay));
 *     delay = nextBackoffDelay(delay);
 *   }
 */
export function nextBackoffDelay(currentMs: number, maxMs: number = DEFAULT_MAX_DELAY_MS): number {
  return Math.min(currentMs * 2, maxMs);
}

/**
 * Apply full jitter (AWS recommended) to a backoff delay.
 *
 * Returns a uniform random value in `[0, delayMs)`. Spreading retries across the
 * backoff window prevents the thundering-herd pattern where every throttled
 * client wakes up at the same instant and re-throttles the service.
 * See https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/
 */
export function fullJitter(delayMs: number): number {
  return Math.random() * delayMs;
}

/**
 * Starting delay for UnprocessedItems / UnprocessedKeys retry loops.
 */
export const INITIAL_BACKOFF_DELAY_MS = DEFAULT_INITIAL_DELAY_MS;

/**
 * Maximum delay for UnprocessedItems / UnprocessedKeys retry loops.
 */
export const MAX_BACKOFF_DELAY_MS = DEFAULT_MAX_DELAY_MS;
