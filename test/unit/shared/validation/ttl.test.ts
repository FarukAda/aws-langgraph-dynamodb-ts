import { MAX_TTL_DAYS, MAX_TTL_SECONDS } from '../../../../src/shared/constants';
import { calculateTtlTimestamp, resolveTtlSeconds } from '../../../../src/shared/validation/ttl';
import { FROZEN_NOW_MS } from '../../../shared/helpers/test-setup';

describe('resolveTtlSeconds', () => {
  it('converts days and seconds forms', () => {
    expect(resolveTtlSeconds({ days: 2 })).toBe(2 * 86400);
    expect(resolveTtlSeconds({ seconds: 90 })).toBe(90);
  });

  it('rejects non-positive or non-integer values', () => {
    expect(() => resolveTtlSeconds({ days: 0 })).toThrow(/ttl.days/);
    expect(() => resolveTtlSeconds({ seconds: 1.5 })).toThrow(/ttl.seconds/);
  });

  it('caps ttl.days at five years and says so', () => {
    expect(resolveTtlSeconds({ days: MAX_TTL_DAYS })).toBe(MAX_TTL_DAYS * 86400);
    expect(() => resolveTtlSeconds({ days: MAX_TTL_DAYS + 1 })).toThrow(
      'ttl.days must be <= 1825 (five years)',
    );
  });

  it('caps ttl.seconds at the same five years as ttl.days (DDB-08)', () => {
    expect(resolveTtlSeconds({ seconds: MAX_TTL_SECONDS })).toBe(MAX_TTL_DAYS * 86400);
    expect(() => resolveTtlSeconds({ seconds: MAX_TTL_SECONDS + 1 })).toThrow(
      'ttl.seconds must be <= 157680000 (five years)',
    );
  });

  it('rejects an object carrying both days and seconds instead of silently preferring days (CORE-14)', () => {
    expect(() => resolveTtlSeconds({ days: 1, seconds: 60 } as never)).toThrow(
      /either ttl.days or ttl.seconds, not both/,
    );
  });
});

describe('calculateTtlTimestamp', () => {
  it('adds the resolved seconds to the frozen now (epoch seconds)', () => {
    expect(calculateTtlTimestamp({ seconds: 100 })).toBe(Math.floor(FROZEN_NOW_MS / 1000) + 100);
  });
});
