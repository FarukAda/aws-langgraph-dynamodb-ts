import { createUlidFactory } from '../../../src/shared/ulid';

describe('createUlidFactory', () => {
  it('works with the default Date.now / Math.random seams', () => {
    const id = createUlidFactory()();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('produces 26-char Crockford-base32 ULIDs', () => {
    const ulid = createUlidFactory(
      () => 0,
      () => 0,
    );
    const id = ulid();
    expect(id).toHaveLength(26);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it('encodes time in the first 10 chars so newer sorts after older', () => {
    const early = createUlidFactory(
      () => 1_000,
      () => 0,
    )();
    const late = createUlidFactory(
      () => 2_000,
      () => 0,
    )();
    expect(late > early).toBe(true);
  });

  it('is monotonic within the same millisecond (strictly increasing)', () => {
    const ulid = createUlidFactory(
      () => 5_000,
      () => 0,
    );
    const a = ulid();
    const b = ulid();
    const c = ulid();
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });

  it('resets the random component when the clock advances', () => {
    let t = 1;
    const ulid = createUlidFactory(
      () => t,
      () => 0,
    );
    const first = ulid();
    t = 2;
    const second = ulid();
    expect(second.slice(0, 10) > first.slice(0, 10)).toBe(true);
  });

  it('increments with carry when a low digit is at max (still strictly increasing)', () => {
    let call = 0;
    const ulid = createUlidFactory(
      () => 9,
      () => (++call === 16 ? 0.999 : 0),
    );
    const a = ulid();
    const b = ulid();
    expect(b > a).toBe(true);
  });

  it('stays strictly increasing when the clock moves backwards', () => {
    let t = 100;
    const ulid = createUlidFactory(
      () => t,
      () => 0.5,
    );
    const first = ulid();
    t = 50;
    const second = ulid();
    expect(second > first).toBe(true);
  });

  it('carries into the timestamp when the same-ms random component overflows', () => {
    const ulid = createUlidFactory(
      () => 100,
      () => 0.999999,
    );
    const first = ulid();
    const second = ulid();
    expect(second > first).toBe(true);
    expect(second.slice(0, 10)).not.toBe(first.slice(0, 10));
  });
});
