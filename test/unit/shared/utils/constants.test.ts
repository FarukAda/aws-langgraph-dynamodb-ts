/**
 * Unit tests for src/shared/utils/constants.ts.
 *
 * Real surface (src/shared/utils/constants.ts):
 *   export const MAX_TTL_DAYS = 365 * 5;             // 1825 (5 years)
 *   export const MAX_LOOP_ITERATIONS = 1000;
 *   export const MAX_TOTAL_ITEMS_IN_MEMORY = 10000;
 *   export const BATCH_WRITE_MAX = 25;               // DynamoDB BatchWriteItem cap
 *   export const MAX_UNPROCESSED_RETRIES = 10;
 *   export function validateTTLDays(ttlDays: number | undefined): void
 *
 * Every value below is pinned to the literal the source defines (read directly
 * from src/shared/utils/constants.ts). validateTTLDays throws:
 *   'TTL days must be an integer'       (non-number / non-integer)
 *   'TTL days must be positive'         (<= 0)
 *   'TTL days cannot exceed <MAX_TTL_DAYS>' (> MAX_TTL_DAYS)
 * and returns void (no throw) for undefined and for any valid 1..MAX_TTL_DAYS.
 *
 * Asserts the exact exported values/identifiers so a drift in any constant is
 * caught here.
 */
import {
  MAX_TTL_DAYS,
  MAX_LOOP_ITERATIONS,
  MAX_TOTAL_ITEMS_IN_MEMORY,
  BATCH_WRITE_MAX,
  MAX_UNPROCESSED_RETRIES,
  validateTTLDays,
} from '../../../../src/shared/utils/constants';

describe('constants — exact exported values', () => {
  it('MAX_TTL_DAYS is exactly 365 * 5 === 1825 (five years)', () => {
    expect(MAX_TTL_DAYS).toBe(1825);
    expect(MAX_TTL_DAYS).toBe(365 * 5);
  }); // AC-17

  it('MAX_LOOP_ITERATIONS is exactly 1000', () => {
    expect(MAX_LOOP_ITERATIONS).toBe(1000);
  }); // AC-17

  it('MAX_TOTAL_ITEMS_IN_MEMORY is exactly 10000', () => {
    expect(MAX_TOTAL_ITEMS_IN_MEMORY).toBe(10000);
  }); // AC-17

  it('BATCH_WRITE_MAX is exactly 25 (DynamoDB BatchWriteItem per-request cap)', () => {
    expect(BATCH_WRITE_MAX).toBe(25);
  }); // AC-32

  it('MAX_UNPROCESSED_RETRIES is exactly 10', () => {
    expect(MAX_UNPROCESSED_RETRIES).toBe(10);
  }); // AC-17
});

describe('validateTTLDays', () => {
  it('returns void (does not throw) for undefined (TTL disabled)', () => {
    expect(validateTTLDays(undefined)).toBeUndefined();
  }); // AC-17

  it('returns void for a valid positive integer within range (positive case)', () => {
    expect(validateTTLDays(30)).toBeUndefined();
    expect(validateTTLDays(1)).toBeUndefined();
    expect(validateTTLDays(MAX_TTL_DAYS)).toBeUndefined();
  }); // AC-17

  it('throws "TTL days must be an integer" for a non-integer value', () => {
    expect(() => validateTTLDays(1.5)).toThrow('TTL days must be an integer');
  }); // AC-17

  it('throws "TTL days must be an integer" for a NaN value', () => {
    expect(() => validateTTLDays(Number.NaN)).toThrow('TTL days must be an integer');
  }); // AC-17

  it('throws "TTL days must be positive" for zero (boundary)', () => {
    expect(() => validateTTLDays(0)).toThrow('TTL days must be positive');
  }); // AC-17

  it('throws "TTL days must be positive" for a negative value', () => {
    expect(() => validateTTLDays(-1)).toThrow('TTL days must be positive');
  }); // AC-17

  it('throws "TTL days cannot exceed <MAX_TTL_DAYS>" just past the ceiling (boundary)', () => {
    expect(() => validateTTLDays(MAX_TTL_DAYS + 1)).toThrow(
      `TTL days cannot exceed ${MAX_TTL_DAYS}`,
    );
  }); // AC-17
});
