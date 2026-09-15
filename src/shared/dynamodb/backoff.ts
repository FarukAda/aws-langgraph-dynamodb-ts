import { MAX_BACKOFF_DELAY_MS } from '../constants';
import { abortErrorFrom } from './abort';

/**
 * Wait `ms` milliseconds, cancellable.
 *
 * Accepts: `ms` — the delay. `signal` — omitted waits uninterruptibly; already
 * aborted rejects before any timer is set; aborting while pending rejects at
 * that moment and clears the timer.
 *
 * Returns: a promise resolving when the delay elapses.
 *
 * Throws: `AbortError` (`code === 'ABORTED'`) however the signal was aborted —
 * with a `DOMException`, a string or a custom reason (see
 * {@link abortErrorFrom}).
 *
 * Guarantees: exactly one of resolve and reject runs, and neither the timer nor
 * the abort listener outlives the call.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortErrorFrom(signal));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(abortErrorFrom(signal as AbortSignal));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The next exponential-backoff delay.
 *
 * Accepts: `currentMs` — the delay just used; at least 1, since doubling 0
 * never grows. `maxMs` — the ceiling, default {@link MAX_BACKOFF_DELAY_MS}.
 *
 * Returns: `min(currentMs * 2, maxMs)`.
 *
 * Throws: nothing.
 */
export function nextBackoffDelay(currentMs: number, maxMs: number = MAX_BACKOFF_DELAY_MS): number {
  return Math.min(currentMs * 2, maxMs);
}

/**
 * AWS's full jitter over a backoff delay.
 *
 * Accepts: `delayMs` — the unjittered delay. `rng` — a seam returning
 * `[0, 1)`, default `Math.random`; tests inject a fixed one.
 *
 * Returns: a value in `[0, delayMs)`, so two clients retrying the same failure
 * do not retry together
 * (https://aws.amazon.com/builders-library/timeouts-retries-and-backoff-with-jitter/).
 *
 * Throws: nothing.
 */
export function fullJitter(delayMs: number, rng: () => number = Math.random): number {
  return rng() * delayMs;
}
