import {
  COMPRESSED_MARKER,
  hasCompressedMarker,
  isGzipped,
} from '../../../../src/shared/codec/compression-markers';

describe('compression markers', () => {
  it('detects the LGC marker', () => {
    expect(hasCompressedMarker(new Uint8Array([0x4c, 0x47, 0x43, 1, 2]))).toBe(true);
    expect(hasCompressedMarker(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(hasCompressedMarker(new Uint8Array([0x4c]))).toBe(false);
  });

  it('detects the gzip magic number', () => {
    expect(isGzipped(new Uint8Array([0x1f, 0x8b, 0]))).toBe(true);
    expect(isGzipped(new Uint8Array([0x1f]))).toBe(false);
  });

  it('exposes the 3-byte LGC marker', () => {
    expect(Array.from(COMPRESSED_MARKER)).toEqual([0x4c, 0x47, 0x43]);
  });
});
