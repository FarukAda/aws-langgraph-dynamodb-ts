import { compress, decompress } from '../../../../src/shared/codec/compression';
import { isPermanentPayloadLoss } from '../../../../src/shared/codec/payload-loss';
import { ErrorCode } from '../../../../src/shared/errors/error-code';

/** Compressible: 4 KiB of one byte, well over the default minimum. */
const big = new Uint8Array(4096).fill(65);

function incompressiblePayload(size: number): Uint8Array {
  const out = new Uint8Array(size);
  for (let index = 0; index < size; index++) {
    out[index] = Math.floor(Math.random() * 256);
  }
  return out;
}

describe('compress', () => {
  it('returns the input untouched when compression is disabled', async () => {
    const { bytes, compressed } = await compress(big, { enabled: false });
    expect(compressed).toBe(false);
    expect(bytes).toBe(big);
  });

  it('does not attempt gzip below the minimum size', async () => {
    const small = new Uint8Array([1, 2, 3]);
    expect(await compress(small, { enabled: true })).toEqual({ bytes: small, compressed: false });
    expect(await compress(big, { enabled: true, minSizeBytes: 1 << 20 })).toEqual({
      bytes: big,
      compressed: false,
    });
  });

  it('compresses at or above the minimum size when gzip beats the input by 10%', async () => {
    const { bytes, compressed } = await compress(big, { enabled: true, minSizeBytes: big.length });
    expect(compressed).toBe(true);
    expect(bytes.length).toBeLessThan(big.length * 0.9);
  });

  /** The flag is the contract: a caller must never infer compression from the bytes. */
  it('keeps the input when gzip saves less than 10%', async () => {
    const random = incompressiblePayload(2048);
    expect(await compress(random, { enabled: true, minSizeBytes: 1024 })).toEqual({
      bytes: random,
      compressed: false,
    });
  });

  it('passes the level through to zlib', async () => {
    const fast = await compress(big, { enabled: true, level: 1 });
    const best = await compress(big, { enabled: true, level: 9 });
    expect(best.bytes.length).toBeLessThanOrEqual(fast.bytes.length);
  });

  it('handles empty input when the minimum is zero', async () => {
    const empty = new Uint8Array();
    expect(await compress(empty, { enabled: true, minSizeBytes: 0 })).toEqual({
      bytes: empty,
      compressed: false,
    });
  });
});

describe('decompress', () => {
  it('returns the bytes unchanged when the flag is false, inspecting nothing', async () => {
    const raw = new Uint8Array([9, 9, 9]);
    expect(await decompress(raw, false)).toEqual(raw);
    const gzipLike = new Uint8Array([0x1f, 0x8b, 0x08, 0, 0]);
    expect(await decompress(gzipLike, false)).toEqual(gzipLike);
  });

  it('round-trips what compress produced', async () => {
    const { bytes } = await compress(big, { enabled: true });
    expect(await decompress(bytes, true)).toEqual(big);
  });

  it('throws COMPRESSION_LIMIT when the output would exceed the cap', async () => {
    const { bytes } = await compress(big, { enabled: true });
    await expect(decompress(bytes, true, 10)).rejects.toMatchObject({
      code: ErrorCode.COMPRESSION_LIMIT,
    });
  });

  /**
   * A row that says gzip and holds something else can never be read. Reported
   * as a raw `Z_DATA_ERROR` it carried no package code, so a caller could not
   * tell it from a transient failure and retried a payload that was lost.
   */
  it('throws PAYLOAD_CORRUPT when the flag is true but the bytes are not gzip', async () => {
    const corrupt = new Uint8Array([0x00, 0x01, 0x02]);
    await expect(decompress(corrupt, true)).rejects.toMatchObject({
      code: ErrorCode.PAYLOAD_CORRUPT,
    });
  });

  it('keeps the zlib failure as the cause', async () => {
    const error = (await decompress(new Uint8Array([0, 1, 2]), true).catch(
      (e: Error) => e,
    )) as Error;
    expect((error.cause as { code?: string } | undefined)?.code).toBe('Z_DATA_ERROR');
  });

  it('reports a corrupt payload as permanent, so a caller reports instead of retrying', async () => {
    const error = (await decompress(new Uint8Array([0, 1, 2]), true).catch(
      (e: Error) => e,
    )) as Error;
    expect(isPermanentPayloadLoss(error)).toBe(true);
  });
});
