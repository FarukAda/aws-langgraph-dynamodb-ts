import { MAX_TTL_DAYS, MAX_TTL_SECONDS } from '../../../../src/shared/constants';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import {
  calculateTtlTimestamp,
  lifecycleExpirationDays,
  resolveTtlSeconds,
} from '../../../../src/shared/validation/ttl';
import { FROZEN_NOW_MS } from '../../../shared/helpers/test-setup';

function expectValidationError(fn: () => void, field: string): void {
  try {
    fn();
    throw new Error('expected a throw');
  } catch (error) {
    const coded = error as { code?: string; context?: { field?: string } };
    expect(coded.code).toBe(ErrorCode.VALIDATION);
    expect(coded.context?.field).toBe(field);
  }
}

describe('resolveTtlSeconds shape', () => {
  it.each([undefined, null, 42, 'a day', []] as never[])(
    'rejects %p, which names no unit at all',
    (ttl) => {
      expectValidationError(() => resolveTtlSeconds(ttl), 'ttl');
    },
  );

  it('rejects an object carrying neither key', () => {
    expectValidationError(() => resolveTtlSeconds({} as never), 'ttl');
  });

  /**
   * A typo reaches this cell, and a message naming `ttl.seconds` would
   * misdirect; the key the caller actually wrote is the one to name.
   */
  it('rejects a misspelt unit by naming the key written, not the unit it guessed', () => {
    expectValidationError(() => resolveTtlSeconds({ day: 1 } as never), 'ttl.day');
  });

  /** Checked before the unit, so a valid unit beside it does not hide the stray key. */
  it('rejects a key beside a valid unit, naming that key', () => {
    expectValidationError(() => resolveTtlSeconds({ days: 1, foo: 1 } as never), 'ttl.foo');
    expectValidationError(() => resolveTtlSeconds({ seconds: 60, foo: 1 } as never), 'ttl.foo');
  });

  it('rejects an object carrying both days and seconds instead of preferring one (CORE-14)', () => {
    expect(() => resolveTtlSeconds({ days: 1, seconds: 60 } as never)).toThrow(
      /either ttl.days or ttl.seconds, not both/,
    );
  });
});

describe('resolveTtlSeconds value', () => {
  it('converts the days form to seconds and returns the seconds form unchanged', () => {
    expect(resolveTtlSeconds({ days: 2 })).toBe(2 * 86400);
    expect(resolveTtlSeconds({ seconds: 90 })).toBe(90);
  });

  it.each([0, -1, 1.5, Number.NaN, undefined as never])('rejects ttl.days %p', (days) => {
    expectValidationError(() => resolveTtlSeconds({ days }), 'ttl.days');
  });

  it.each([0, -1, 1.5, Number.NaN, undefined as never])('rejects ttl.seconds %p', (seconds) => {
    expectValidationError(() => resolveTtlSeconds({ seconds }), 'ttl.seconds');
  });

  it('accepts exactly five years and rejects one more, in either unit', () => {
    expect(resolveTtlSeconds({ days: MAX_TTL_DAYS })).toBe(MAX_TTL_SECONDS);
    expect(resolveTtlSeconds({ seconds: MAX_TTL_SECONDS })).toBe(MAX_TTL_SECONDS);
    expect(() => resolveTtlSeconds({ days: MAX_TTL_DAYS + 1 })).toThrow(
      'ttl.days must be <= 1825 (five years)',
    );
    expect(() => resolveTtlSeconds({ seconds: MAX_TTL_SECONDS + 1 })).toThrow(
      'ttl.seconds must be <= 157680000 (five years)',
    );
  });
});

describe('calculateTtlTimestamp', () => {
  it('adds the resolved seconds to the clock, in whole epoch seconds', () => {
    expect(calculateTtlTimestamp({ seconds: 100 })).toBe(Math.floor(FROZEN_NOW_MS / 1000) + 100);
  });

  it('reads the injected clock as milliseconds and floors it', () => {
    expect(calculateTtlTimestamp({ seconds: 1 }, () => 1_500)).toBe(2);
    expect(calculateTtlTimestamp({ seconds: 1 }, () => 1_999)).toBe(2);
  });

  it('rejects the ttl before it reads the clock', () => {
    const clock = jest.fn(() => 0);
    expectValidationError(() => calculateTtlTimestamp({} as never, clock), 'ttl');
  });
});

describe('lifecycleExpirationDays (CODEC-08)', () => {
  /**
   * The guarantee: the object outlives its row. S3 expires at the first
   * midnight UTC at least `Days` after creation; DynamoDB may keep an expired
   * item ~48 h past its `ttl`, which is what the margin covers.
   */
  it('rounds the ttl up to whole days and adds the two-day sweep margin', () => {
    expect(lifecycleExpirationDays({ days: 7 })).toBe(9);
    expect(lifecycleExpirationDays({ seconds: 86400 })).toBe(3);
  });

  it('rounds a partial day up rather than down', () => {
    expect(lifecycleExpirationDays({ seconds: 1 })).toBe(3);
    expect(lifecycleExpirationDays({ seconds: 86400 + 1 })).toBe(4);
  });

  it('is never shorter than the ttl it backs', () => {
    for (const seconds of [1, 59, 86_400, 86_401, MAX_TTL_SECONDS]) {
      expect(lifecycleExpirationDays({ seconds }) * 86_400).toBeGreaterThan(seconds);
    }
  });

  it('rejects an unresolvable ttl rather than returning the bare margin', () => {
    expectValidationError(() => lifecycleExpirationDays({} as never), 'ttl');
  });
});
