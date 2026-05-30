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

  it('rejects values over the bounds', () => {
    expect(() => resolveTtlSeconds({ days: 365 * 5 + 1 })).toThrow();
  });
});

describe('calculateTtlTimestamp', () => {
  it('adds the resolved seconds to the frozen now (epoch seconds)', () => {
    expect(calculateTtlTimestamp({ seconds: 100 })).toBe(Math.floor(FROZEN_NOW_MS / 1000) + 100);
  });
});
