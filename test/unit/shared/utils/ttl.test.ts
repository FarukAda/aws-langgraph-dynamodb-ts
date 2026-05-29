/**
 * Unit tests for src/shared/utils/ttl.ts.
 *
 * Real surface (src/shared/utils/ttl.ts):
 *   export function calculateTTLTimestampFromSeconds(ttlSeconds: number, now?): number
 *   export function calculateTTLTimestamp(ttlDays: number, now?): number
 *
 * Contract pinned from source:
 *   - return value === Math.floor(now()/1000) + ttlSeconds (days variant scales
 *     ttlDays * 86400 first).
 *   - the seconds variant VALIDATES its input and throws:
 *       'ttlSeconds must be an integer'  (non-integer / non-number)
 *       'ttlSeconds must be positive'    (<= 0)
 *       'ttlSeconds cannot exceed <MAX_TTL_SECONDS> (100 years)' (> 100 years)
 *     MAX_TTL_SECONDS === 100 * 365 * 24 * 60 * 60 = 3_153_600_000.
 *   - calculateTTLTimestamp(days) forwards days*86400 into the seconds variant,
 *     so days===0 and negative days REJECT via the 'must be positive' guard.
 *
 * Plan rows: AC-9 (exact TTL math), AC-35 (frozen Date.now() default),
 * AC-38 (clock seam default-vs-injected). REQ-13 / REQ-43 / REQ-48.
 *
 * The injectable clock seam (REQ-43, optional last param `now: () => number =
 * Date.now`) does not exist in source yet, so the AC-38 injected-clock cases are
 * expected to fail to compile until the seam lands; everything else references
 * the real surface and compiles today.
 */
import {
  calculateTTLTimestamp,
  calculateTTLTimestampFromSeconds,
} from '../../../../src/shared/utils/ttl';
import { EXPECTED_TTL_30D, FROZEN_NOW_MS } from '../../../shared/helpers/frozen-time';

const SECONDS_PER_DAY = 86_400;
/** 100 years in seconds — the source's MAX_TTL_SECONDS bound. */
const MAX_TTL_SECONDS = 100 * 365 * 24 * 60 * 60;

describe('calculateTTLTimestamp (days)', () => {
  it('returns exactly Math.floor(FROZEN_NOW_MS/1000) + 30*86400 for a 30-day TTL at the frozen epoch', () => {
    // Exact integer assert — no expect.any. (REQ-13 / AC-9)
    expect(calculateTTLTimestamp(30)).toBe(EXPECTED_TTL_30D);
    expect(calculateTTLTimestamp(30)).toBe(Math.floor(FROZEN_NOW_MS / 1000) + 30 * SECONDS_PER_DAY);
  }); // AC-9

  it('confirms the default clock reads the frozen Date.now() (determinism default)', () => {
    // AC-35: with the jest config Date.now() is frozen to FROZEN_NOW_MS, so the
    // default-clock result is the pinned constant.
    expect(Date.now()).toBe(FROZEN_NOW_MS);
    expect(calculateTTLTimestamp(1)).toBe(Math.floor(FROZEN_NOW_MS / 1000) + SECONDS_PER_DAY);
  }); // AC-35

  it('rejects a zero-day TTL with "ttlSeconds must be positive" (boundary, via the seconds guard)', () => {
    // days===0 scales to 0 seconds, which the seconds variant rejects.
    expect(() => calculateTTLTimestamp(0)).toThrow('ttlSeconds must be positive');
  }); // AC-9

  it('rejects a negative-day TTL with "ttlSeconds must be positive" (negative input)', () => {
    // -1 day scales to -86400 seconds, rejected by the positivity guard.
    expect(() => calculateTTLTimestamp(-1)).toThrow('ttlSeconds must be positive');
  }); // AC-9
});

describe('calculateTTLTimestampFromSeconds (seconds)', () => {
  it('returns Math.floor(now/1000) + ttlSeconds for a positive integer second count', () => {
    expect(calculateTTLTimestampFromSeconds(3_600)).toBe(Math.floor(FROZEN_NOW_MS / 1000) + 3_600);
  }); // AC-9

  it('throws "ttlSeconds must be an integer" for a non-integer second count', () => {
    expect(() => calculateTTLTimestampFromSeconds(1.5)).toThrow('ttlSeconds must be an integer');
  }); // AC-9

  it('throws "ttlSeconds must be positive" for zero or negative seconds (boundary)', () => {
    expect(() => calculateTTLTimestampFromSeconds(0)).toThrow('ttlSeconds must be positive');
    expect(() => calculateTTLTimestampFromSeconds(-1)).toThrow('ttlSeconds must be positive');
  }); // AC-9

  it('throws the 100-year ceiling error when ttlSeconds exceeds MAX_TTL_SECONDS', () => {
    expect(() => calculateTTLTimestampFromSeconds(MAX_TTL_SECONDS + 1)).toThrow(
      `ttlSeconds cannot exceed ${MAX_TTL_SECONDS} (100 years)`,
    );
  }); // AC-9

  it('accepts exactly MAX_TTL_SECONDS at the boundary', () => {
    expect(calculateTTLTimestampFromSeconds(MAX_TTL_SECONDS)).toBe(
      Math.floor(FROZEN_NOW_MS / 1000) + MAX_TTL_SECONDS,
    );
  }); // AC-9
});

describe('TTL clock seam (REQ-43 / AC-38)', () => {
  it('default clock (no injection) is byte-identical to reading the frozen Date.now()', () => {
    // Default param must reproduce pre-seam behavior exactly.
    const viaDefault = calculateTTLTimestamp(30);
    const viaExplicitFrozen = calculateTTLTimestamp(30, () => FROZEN_NOW_MS);
    expect(viaDefault).toBe(viaExplicitFrozen);
    expect(viaDefault).toBe(EXPECTED_TTL_30D);
  }); // AC-38

  it('uses the injected clock instead of Date.now() (seam is consulted)', () => {
    const injected = 2_000_000_000_000;
    expect(calculateTTLTimestamp(30, () => injected)).toBe(
      Math.floor(injected / 1000) + 30 * SECONDS_PER_DAY,
    );
    // And the injected clock must differ from the frozen-default result.
    expect(calculateTTLTimestamp(30, () => injected)).not.toBe(EXPECTED_TTL_30D);
  }); // AC-38

  it('calculateTTLTimestampFromSeconds forwards an injected clock', () => {
    const injected = 1_234_567_890_000;
    expect(calculateTTLTimestampFromSeconds(10, () => injected)).toBe(
      Math.floor(injected / 1000) + 10,
    );
  }); // AC-38
});
