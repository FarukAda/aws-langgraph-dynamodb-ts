import fc from 'fast-check';

import { fullJitter, nextBackoffDelay } from '../../src/shared/dynamodb/backoff';
import { withRetry } from '../../src/shared/dynamodb/retry';
import { RetryExhaustedError } from '../../src/shared/errors/errors';

const unit = fc.double({ min: 0, max: 0.999999, noNaN: true });

describe('backoff (property)', () => {
  it('fullJitter stays within [0, delay)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 10_000 }), unit, (delay, r) => {
        const jittered = fullJitter(delay, () => r);
        expect(jittered).toBeGreaterThanOrEqual(0);
        expect(jittered).toBeLessThan(delay);
      }),
    );
  });

  it('nextBackoffDelay doubles until the cap and never exceeds it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 10_000 }),
        (current, max) => {
          const next = nextBackoffDelay(current, max);
          expect(next).toBe(Math.min(current * 2, max));
          expect(next).toBeLessThanOrEqual(max);
        },
      ),
    );
  });

  it('withRetry sleeps rng · min(base · 2^(attempt-1), max) before each retry and exhausts at maxAttempts', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 2, max: 4 }),
        unit,
        async (base, max, maxAttempts, r) => {
          const delays: number[] = [];
          let calls = 0;
          await expect(
            withRetry(
              async () => {
                calls += 1;
                throw Object.assign(new Error('slow'), { name: 'ThrottlingException' });
              },
              {
                maxAttempts,
                baseDelayMs: base,
                maxDelayMs: max,
                rng: () => r,
                onRetry: (info) => delays.push(info.delayMs),
              },
            ),
          ).rejects.toBeInstanceOf(RetryExhaustedError);
          expect(calls).toBe(maxAttempts);
          expect(delays).toEqual(
            Array.from({ length: maxAttempts - 1 }, (_, i) => r * Math.min(base * 2 ** i, max)),
          );
        },
      ),
      { numRuns: 25 },
    );
  });
});
