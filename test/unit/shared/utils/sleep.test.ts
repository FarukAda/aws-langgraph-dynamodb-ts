/**
 * Unit tests for src/shared/utils/sleep.ts.
 *
 * Real surface (src/shared/utils/sleep.ts):
 *   export function sleep(ms: number, signal?: AbortSignal): Promise<void>
 *   export function nextBackoffDelay(currentMs: number, maxMs?: number): number
 *   export function fullJitter(delayMs: number, rng?): number
 *   export const INITIAL_BACKOFF_DELAY_MS = 100
 *   export const MAX_BACKOFF_DELAY_MS = 5000
 *
 * Pinned from source:
 *   - sleep rejects synchronously with `signal.reason ?? new Error('Aborted')`
 *     when the signal is already aborted, arming no timer; otherwise resolves
 *     after exactly `ms` on the timer.
 *   - nextBackoffDelay(currentMs, maxMs=5000) === Math.min(currentMs * 2, maxMs)
 *     — EXACT doubling capped at maxMs (default 5000).
 *   - fullJitter(delayMs) === Math.random() * delayMs — range [0, delayMs);
 *     rng()===0 yields 0.
 *
 * Plan: AC-18 (abort), AC-38 (fullJitter RNG seam default-vs-injected).
 * REQ-44 / REQ-48 / AC-18 / AC-38.
 *
 * The `rng?` seam on fullJitter (REQ-44) does not exist in source yet, so the
 * injected-rng cases are expected to fail to compile until the seam lands;
 * everything else references the real surface and compiles today.
 */
import {
  sleep,
  fullJitter,
  nextBackoffDelay,
  INITIAL_BACKOFF_DELAY_MS,
  MAX_BACKOFF_DELAY_MS,
} from '../../../../src/shared/utils/sleep';
import { preAbortedSignal } from '../../../shared/helpers/abort';
import { seededRandom } from '../../../shared/helpers/frozen-time';

describe('sleep (deterministic, fake timers)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves only after exactly the requested delay has elapsed on the fake clock', async () => {
    const fn = jest.fn();
    const p = sleep(500).then(fn);

    // Not yet: advance to just before the deadline.
    await jest.advanceTimersByTimeAsync(499);
    expect(fn).not.toHaveBeenCalled();

    // Cross the deadline: now it resolves. No real wall-clock wait occurred.
    await jest.advanceTimersByTimeAsync(1);
    await p;
    expect(fn).toHaveBeenCalledTimes(1);
  }); // AC-38

  it('rejects with the signal abort reason when the signal is already aborted, scheduling no timer', async () => {
    const reason = new Error('stop');
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    await expect(sleep(1_000, preAbortedSignal(reason))).rejects.toBe(reason);
    // A pre-aborted sleep must short-circuit without arming a timer.
    expect(setTimeoutSpy).not.toHaveBeenCalled();
    setTimeoutSpy.mockRestore();
  }); // AC-18

  it('rejects with the signal reason when aborted mid-sleep, clearing the timer', async () => {
    const reason = new Error('mid-abort');
    const controller = new AbortController();
    const clearTimeoutSpy = jest.spyOn(globalThis, 'clearTimeout');
    const rejection = expect(sleep(1_000, controller.signal)).rejects.toBe(reason);
    controller.abort(reason);
    await rejection;
    // The pending timer must be cleared on abort so it cannot also resolve.
    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  }); // AC-18
});

describe('fullJitter', () => {
  it('default RNG path returns a value within [0, delayMs] (pre-seam behavior preserved)', () => {
    // No rng injected => Math.random (seeded by test-setup). Full jitter range
    // is [0, delayMs). This is the byte-identical default contract.
    const delay = 1_000;
    const value = fullJitter(delay);
    expect(value).toBeGreaterThanOrEqual(0);
    expect(value).toBeLessThan(delay);
  }); // AC-38

  it('injected rng=()=>0 yields exactly 0 and a near-1 draw yields just under the full delay', () => {
    const delay = 1_000;
    // Full jitter: rng() in [0,1) scaled to [0, delay). rng()===0 => 0.
    expect(fullJitter(delay, () => 0)).toBe(0);
    // rng()===0.5 draws exactly half the delay — an exact, pinned value.
    expect(fullJitter(delay, () => 0.5)).toBe(500);
    // A near-1 draw is the largest observable jitter and strictly exceeds the
    // 0-draw while staying under the delay.
    const high = fullJitter(delay, () => 0.999999);
    expect(high).toBeGreaterThan(0);
    expect(high).toBeLessThan(delay);
  }); // AC-38

  it('two different seeded RNGs produce different jitter for the same delay (negative: not constant)', () => {
    const delay = 5_000;
    const a = fullJitter(delay, seededRandom(1));
    const b = fullJitter(delay, seededRandom(987_654));
    expect(a).not.toBe(b);
  }); // AC-38
});

describe('nextBackoffDelay (exact doubling, capped)', () => {
  it('doubles the current delay exactly when below the cap', () => {
    // Math.min(currentMs * 2, maxMs).
    expect(nextBackoffDelay(100, 100_000)).toBe(200);
    expect(nextBackoffDelay(200, 100_000)).toBe(400);
    expect(nextBackoffDelay(2_500, 100_000)).toBe(5_000);
  }); // AC-38

  it('caps the doubled delay at maxMs exactly (boundary)', () => {
    expect(nextBackoffDelay(1_000_000, 5_000)).toBe(5_000);
    // At the cap, doubling still returns exactly the cap.
    expect(nextBackoffDelay(5_000, 5_000)).toBe(5_000);
  }); // AC-38

  it('defaults maxMs to MAX_BACKOFF_DELAY_MS (5000) when omitted', () => {
    // Doubling 4000 -> 8000 is capped to the default 5000.
    expect(nextBackoffDelay(4_000)).toBe(MAX_BACKOFF_DELAY_MS);
    expect(MAX_BACKOFF_DELAY_MS).toBe(5_000);
  }); // AC-38
});

describe('exported backoff bounds', () => {
  it('INITIAL_BACKOFF_DELAY_MS is exactly 100 and MAX_BACKOFF_DELAY_MS is exactly 5000', () => {
    expect(INITIAL_BACKOFF_DELAY_MS).toBe(100);
    expect(MAX_BACKOFF_DELAY_MS).toBe(5_000);
  }); // AC-38
});
