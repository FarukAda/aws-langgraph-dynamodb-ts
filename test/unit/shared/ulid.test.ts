import { randomBytes } from 'node:crypto';

import { createUlidFactory, secureRng, ulidTimePrefix } from '../../../src/shared/ulid';

jest.mock('node:crypto', () => {
  const actual = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, randomBytes: jest.fn(actual.randomBytes) };
});

const randomBytesMock = randomBytes as jest.MockedFunction<typeof randomBytes>;

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

describe('secureRng (DDB-12)', () => {
  it('draws from crypto.randomBytes through a refilled pool and stays within [0, 1)', () => {
    randomBytesMock.mockClear();
    const rng = secureRng();
    const values = Array.from({ length: 257 }, () => rng());
    expect(values.every((value) => value >= 0 && value < 1)).toBe(true);
    expect(randomBytesMock).toHaveBeenCalledTimes(2);
  });

  /**
   * The guarantee the CSPRNG is there for: a digit drawn as `floor(rng() * 32)`
   * must be uniform. 256 is a whole multiple of 32, so every digit comes from
   * exactly eight byte values and no digit is more likely than another.
   */
  it('maps every byte onto a digit without modulo bias', () => {
    randomBytesMock.mockClear();
    const everyByte = Buffer.from(Array.from({ length: 256 }, (_v, index) => index));
    (randomBytesMock as unknown as jest.Mock).mockReturnValueOnce(everyByte);
    const rng = secureRng();
    const histogram = new Array<number>(32).fill(0);
    for (let draw = 0; draw < 256; draw += 1) histogram[Math.floor(rng() * 32)] += 1;
    expect(histogram).toEqual(new Array<number>(32).fill(8));
  });

  it('is the default random source of a ULID factory', () => {
    randomBytesMock.mockClear();
    const id = createUlidFactory()();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(randomBytesMock).toHaveBeenCalled();
  });
});

describe('ulidTimePrefix (HIST-06)', () => {
  it('is the 10 time characters every ULID of that millisecond starts with, ordered by time', () => {
    const t = 1_700_000_000_000;
    const prefix = ulidTimePrefix(t);
    expect(prefix).toHaveLength(10);
    expect(createUlidFactory(() => t)().startsWith(prefix)).toBe(true);
    expect(ulidTimePrefix(t - 1) < prefix).toBe(true);
    expect(prefix < ulidTimePrefix(t + 1)).toBe(true);
  });
});
