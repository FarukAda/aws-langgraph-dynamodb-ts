/**
 * Single source of the frozen epoch + RNG seed used by globalSetup and any
 * test that needs to reason about time / jitter.
 *
 * Plan A: "FROZEN_NOW_MS is the single frozen epoch constant.
 * EXPECTED_TTL_30D = Math.floor(FROZEN_NOW_MS/1000) + 30*86400 is the canonical
 * TTL assertion value (REQ-13/AC-9)."
 *
 * NOTE for integration tier: never install fake timers there; the integration
 * variant (test/integration/helpers/frozen-time.ts) provides a real-clock-safe
 * deterministic helper instead.
 */

/** Fixed wall-clock epoch (ms) used as Date.now() across the unit suite. */
export const FROZEN_NOW_MS = 1_700_000_000_000;

/** Canonical 30-day TTL value at the frozen epoch, in epoch seconds. */
export const EXPECTED_TTL_30D = Math.floor(FROZEN_NOW_MS / 1000) + 30 * 86400;

/** Default seed for the deterministic RNG shim. */
export const SEEDED_RNG_DEFAULT_SEED = 0x5eed_1234;

/**
 * Install fake timers and freeze Date.now() to FROZEN_NOW_MS.
 * Returns the value the timers were frozen to for convenience.
 */
export function installFrozenTime(now: number = FROZEN_NOW_MS): number {
  jest.useFakeTimers({ now, doNotFake: [] });
  jest.setSystemTime(now);
  return now;
}

/** Restore real timers after a test that called installFrozenTime(). */
export function restoreTime(): void {
  jest.useRealTimers();
}

/**
 * Deterministic mulberry32 PRNG. Returns a function producing values in [0,1).
 * Used to seed jitter so backoff schedules are exactly assertable (AC-20).
 */
export function seededRandom(seed: number = SEEDED_RNG_DEFAULT_SEED): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
