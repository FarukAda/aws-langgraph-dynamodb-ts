import { gzipSync } from 'node:zlib';

import { compress, decompress } from '../../../../src/shared/codec/compression';
import { COMPRESSED_MARKER } from '../../../../src/shared/codec/compression-markers';
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
  it('round-trips a compressible payload above the threshold', async () => {
    const compressed = await compress(big, { enabled: true });
    expect(compressed.length).toBeLessThan(big.length);
    expect(Array.from(compressed.subarray(0, COMPRESSED_MARKER.length))).toEqual(
      Array.from(COMPRESSED_MARKER),
    );
    expect(await decompress(compressed)).toEqual(big);
  });

  it('passes through payloads below the minimum size unchanged', async () => {
    const small = new Uint8Array([1, 2, 3]);
    expect(await compress(small, { enabled: true })).toBe(small);
  });

  it('passes through unchanged when compression is disabled', async () => {
    expect(await compress(big, { enabled: false })).toBe(big);
  });

  it('returns the original when compression yields no real saving', async () => {
    const random = incompressiblePayload(2048);
    const result = await compress(random, { enabled: true, minSizeBytes: 1024 });
    expect(result).toBe(random);
  });

  it('decompress passes through uncompressed data', async () => {
    const raw = new Uint8Array([9, 9, 9]);
    expect(await decompress(raw)).toEqual(raw);
  });

  it('decompress handles legacy gzip payloads without the LGC marker', async () => {
    const legacy = new Uint8Array(gzipSync(Buffer.from(big)));
    expect(legacy[0]).toBe(0x1f);
    expect(await decompress(legacy)).toEqual(big);
  });

  it('throws COMPRESSION_LIMIT when output would exceed the cap', async () => {
    const compressed = await compress(big, { enabled: true });
    try {
      await decompress(compressed, 10);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code: ErrorCode }).code).toBe(ErrorCode.COMPRESSION_LIMIT);
    }
  });

  it('rethrows non-bomb decompression failures unchanged', async () => {
    const corrupt = new Uint8Array(COMPRESSED_MARKER.length + 3);
    corrupt.set(COMPRESSED_MARKER, 0);
    corrupt.set([0x00, 0x01, 0x02], COMPRESSED_MARKER.length);
    await expect(decompress(corrupt)).rejects.toMatchObject({ code: 'Z_DATA_ERROR' });
  });
});
