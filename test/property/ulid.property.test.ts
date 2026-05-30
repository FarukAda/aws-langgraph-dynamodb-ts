import fc from 'fast-check';

import { createUlidFactory } from '../../src/shared/ulid';

const ULID_LENGTH = 26;
const ENCODING = /^[0-9A-HJKMNP-TV-Z]+$/;

function clockFrom(timestamps: number[]): () => number {
  let index = 0;
  return () => timestamps[Math.min(index++, timestamps.length - 1)];
}

describe('createUlidFactory (property)', () => {
  it('emits strictly increasing, well-formed ids under an adversarial clock', () => {
    const clockArb = fc.array(fc.nat({ max: 2 ** 40 }), { minLength: 2, maxLength: 300 });
    const rngArb = fc.double({ min: 0, max: 0.9999, noNaN: true });
    fc.assert(
      fc.property(clockArb, rngArb, (timestamps, rngValue) => {
        const ulid = createUlidFactory(clockFrom(timestamps), () => rngValue);
        let previous = '';
        for (let i = 0; i < timestamps.length; i++) {
          const id = ulid();
          expect(id).toHaveLength(ULID_LENGTH);
          expect(id).toMatch(ENCODING);
          expect(id > previous).toBe(true);
          previous = id;
        }
      }),
      { numRuns: 300 },
    );
  });
});
