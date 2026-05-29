/**
 * Deterministic-time helper for the INTEGRATION tier.
 *
 * The unit tier freezes time with Jest fake timers, but integration tests run
 * against a real DynamoDB Local instance whose own internal timers (SDK retry,
 * socket keep-alive, table-create polling) would deadlock under fake timers.
 * So integration tests must keep real wall-clock timers running.
 *
 * Instead of faking the global clock, this helper provides an INJECTABLE
 * `Clock` that tests thread into the source seams (REQ-43 / REQ-45:
 * `calculateTTLTimestamp(days, now)`, `buildOptimisticMetadataUpdate(..., now)`,
 * `putOperationAction({ ..., now })`). With a fixed clock injected, the `ttl`
 * attribute persisted into DynamoDB is exactly predictable, so a flow test can
 * assert the stored epoch-seconds value rather than a moving target.
 *
 * `FROZEN_NOW_MS` matches the unit tier's frozen epoch so TTL math is identical
 * across both tiers.
 */

/** A clock seam: returns epoch milliseconds. Matches `() => number` (i.e. `Date.now`). */
export type Clock = () => number;

/**
 * The single frozen epoch used by both tiers, in milliseconds.
 * 2026-05-28T00:00:00.000Z — inside the spec's "current date" so TTL windows
 * land on realistic future timestamps.
 */
export const FROZEN_NOW_MS = 1_780_000_000_000;

/** Frozen epoch in whole seconds — the unit DynamoDB stores its TTL attribute in. */
export const FROZEN_NOW_SECONDS = Math.floor(FROZEN_NOW_MS / 1000);

/** Canonical 30-day TTL value at the frozen epoch (matches the unit tier's EXPECTED_TTL_30D). */
export const EXPECTED_TTL_30D = FROZEN_NOW_SECONDS + 30 * 86400;

/** Number of seconds in one TTL day, as the library computes it. */
export const SECONDS_PER_DAY = 86400;

/**
 * Build a clock pinned to a fixed instant. Pass into any source seam that
 * accepts a `now: () => number` so the persisted `ttl` attribute is exact.
 *
 * @param atMs - the fixed instant in epoch ms (defaults to FROZEN_NOW_MS)
 */
export function fixedClock(atMs: number = FROZEN_NOW_MS): Clock {
  return () => atMs;
}

/**
 * Compute the exact `ttl` epoch-seconds the library will persist for a given
 * day count at a given fixed clock — mirrors `calculateTTLTimestamp`'s contract
 * (`Math.floor(now/1000) + days*86400`) so tests assert the real stored integer.
 */
export function expectedTtlSeconds(ttlDays: number, atMs: number = FROZEN_NOW_MS): number {
  return Math.floor(atMs / 1000) + ttlDays * SECONDS_PER_DAY;
}

/**
 * A monotonic clock seeded at a fixed instant that advances by `stepMs` on each
 * read. Useful where a flow needs two distinct-but-deterministic timestamps
 * (e.g. createdAt then updatedAt) without depending on wall-clock jitter.
 */
export function steppingClock(startMs: number = FROZEN_NOW_MS, stepMs = 1000): Clock {
  let current = startMs;
  return () => {
    const value = current;
    current += stepMs;
    return value;
  };
}
