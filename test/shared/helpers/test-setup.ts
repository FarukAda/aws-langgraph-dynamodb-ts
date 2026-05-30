/**
 * Global determinism harness applied before every test (wired via
 * jest.config.ts `setupFilesAfterEnv`). Freezes the wall clock and seeds the
 * RNG so TTL timestamps and full-jitter backoff schedules are exactly
 * assertable. Real timers are left intact so `sleep()` resolves normally.
 */
export const FROZEN_NOW_MS = 1_700_000_000_000;

const RNG_SEED = 0x9e3779b9;

function createSeededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeEach(() => {
  jest.spyOn(Date, 'now').mockReturnValue(FROZEN_NOW_MS);
  jest.spyOn(Math, 'random').mockImplementation(createSeededRandom(RNG_SEED));
});

afterEach(() => {
  jest.restoreAllMocks();
});
