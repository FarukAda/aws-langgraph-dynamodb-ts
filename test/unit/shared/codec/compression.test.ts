import { compress, decompress } from '../../../../src/shared/codec/compression';
import { ErrorCode } from '../../../../src/shared/errors/error-code';

const big = new Uint8Array(4096).fill(65);

function incompressiblePayload(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let index = 0; index < size; index++) {
    out[index] = Math.floor(Math.random() * 256);
  }
  return out;
}

describe('compress / decompress', () => {
  it('returns compressed bytes and a true flag when gzip saves space', async () => {
    const { bytes, compressed } = await compress(big, { enabled: true });
    expect(compressed).toBe(true);
    expect(bytes.length).toBeLessThan(big.length);
    expect(await decompress(bytes, true)).toEqual(big);
  });

  it('passes through payloads below the minimum size unchanged', async () => {
    const small = new Uint8Array([1, 2, 3]);
    const { bytes, compressed } = await compress(small, { enabled: true });
    expect(compressed).toBe(false);
    expect(bytes).toBe(small);
  });

  it('passes through unchanged when compression is disabled', async () => {
    const { bytes, compressed } = await compress(big, { enabled: false });
    expect(compressed).toBe(false);
    expect(bytes).toBe(big);
  });

  it('returns the original when compression yields no real saving', async () => {
    const random = incompressiblePayload(2048);
    const { bytes, compressed } = await compress(random, { enabled: true, minSizeBytes: 1024 });
    expect(compressed).toBe(false);
    expect(bytes).toBe(random);
  });

  it('returns uncompressed bytes unchanged when the flag is false', async () => {
    const raw = new Uint8Array([9, 9, 9]);
    expect(await decompress(raw, false)).toEqual(raw);
  });

  it('round-trips uncompressed bytes that happen to start with 0x4C 0x47 0x43', async () => {
    const data = new Uint8Array([0x4c, 0x47, 0x43, 9, 9]);
    expect(await decompress(data, false)).toEqual(data);
  });

  it('throws COMPRESSION_LIMIT when output would exceed the cap', async () => {
    const { bytes } = await compress(big, { enabled: true });
    try {
      await decompress(bytes, true, 10);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code: ErrorCode }).code).toBe(ErrorCode.COMPRESSION_LIMIT);
    }
  });

  it('rethrows non-bomb decompression failures unchanged', async () => {
    const corrupt = new Uint8Array([0x00, 0x01, 0x02]);
    await expect(decompress(corrupt, true)).rejects.toMatchObject({ code: 'Z_DATA_ERROR' });
  });
});
