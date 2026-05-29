import { MAX_BACKOFF_DELAY_MS } from '../constants';
import { AbortError } from '../errors/errors';

/**
 * Sleep for `ms` milliseconds, cancellable via `signal`. If `signal` is already
 * aborted the promise rejects synchronously with the abort reason (or an
 * {@link AbortError}); otherwise the timer resolves and the listener is removed.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new AbortError());
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(signal?.reason ?? new AbortError());
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

/** Next exponential-backoff delay: double `currentMs`, capped at `maxMs`. */
export function nextBackoffDelay(currentMs: number, maxMs: number = MAX_BACKOFF_DELAY_MS): number {
  return Math.min(currentMs * 2, maxMs);
}

/**
 * Apply AWS-recommended full jitter: a uniform random value in `[0, delayMs)`.
 *
 * @param rng - RNG seam returning `[0, 1)`. Defaults to `Math.random`.
 */
export function fullJitter(delayMs: number, rng: () => number = Math.random): number {
  return rng() * delayMs;
}
