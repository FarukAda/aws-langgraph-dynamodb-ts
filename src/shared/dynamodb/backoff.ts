import { MAX_BACKOFF_DELAY_MS } from '../constants';
import { abortErrorFrom } from './abort';

/**
 * Sleep for `ms` milliseconds, cancellable via `signal`. An already-aborted
 * signal rejects at once and an abort while pending rejects the moment it fires; both
 * reject with the library's `AbortError` (see `abortErrorFrom`), so a caller
 * branching on `code === 'ABORTED'` sees it however the signal was aborted.
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
