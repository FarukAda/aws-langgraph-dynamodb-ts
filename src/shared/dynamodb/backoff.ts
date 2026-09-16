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
 * the abort listener outlives the call. The listener is attached before the
 * timer is armed, so a signal whose `addEventListener` throws rejects the wait
 * with nothing left behind — armed first, the timer outlived that rejection
 * and later called `removeEventListener` outside any promise. A listener that
 * runs while it is being attached settles the wait before any timer exists.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(abortErrorFrom(signal));
  }
  return new Promise((resolve, reject) => {
    /**
     * One holder for both flags, declared before `onAbort` reads the timer:
     * the timer is assigned only once armed, after the listener is attached.
     */
    const wait: { settled: boolean; timer?: ReturnType<typeof setTimeout> } = { settled: false };
    const onAbort = (): void => {
      if (wait.settled) return;
      wait.settled = true;
      clearTimeout(wait.timer);
      reject(abortErrorFrom(signal as AbortSignal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (wait.settled) return;
    wait.timer = setTimeout(() => {
      if (wait.settled) return;
      wait.settled = true;
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
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
