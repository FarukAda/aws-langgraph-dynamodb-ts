/**
 * Unit tests for src/shared/utils/compressor.ts.
 *
 * Real surface (src/shared/utils/compressor.ts):
 *   export interface CompressionConfig {
 *     enabled: boolean; minSizeBytes?: number; level?: number;
 *     maxDecompressedBytes?: number;
 *   }
 *   export class Compressor {
 *     constructor(config: CompressionConfig);
 *     compress(data: Uint8Array): Promise<Uint8Array>;
 *     decompress(data: Uint8Array): Promise<Uint8Array>;
 *     static hasCompressedMarker(data: Uint8Array): boolean;
 *     static isGzipped(data: Uint8Array): boolean;
 *   }
 *
 * Pinned from source:
 *   - The codec operates on Uint8Array, NOT arbitrary JS values. There is no
 *     standalone compress()/decompress() function — it is a class with instance
 *     methods. So the round-trip property table (AC-15: empty / unicode /
 *     deeply-nested / large-binary) encodes each input to bytes first and asserts
 *     decompress(compress(bytes)) deep-equals bytes.
 *   - compress() only gzips when data.length >= minSizeBytes (default 1024) AND
 *     the compressed+marker output is < 90% of the original; otherwise it returns
 *     the input bytes unchanged. New compressed output is prefixed with the 3-byte
 *     'LGC' marker (0x4C 0x47 0x43).
 *   - decompress() transparently passes through non-marked, non-gzip bytes.
 *   - Documented error: a gzip-bomb whose decompressed size would exceed
 *     maxDecompressedBytes throws
 *     'Refusing to decompress payload: decompressed output would exceed
 *      <maxDecompressedBytes> bytes. ...' (cause = the zlib ERR_BUFFER_TOO_LARGE).
 *
 * REQ-19 / REQ-18 / AC-15.
 */
import { gzipSync } from 'node:zlib';

import { Compressor, type CompressionConfig } from '../../../../src/shared/utils/compressor';

const encoder = new TextEncoder();

/** Encode an arbitrary JSON-able value to bytes for the byte-level codec. */
function toBytes(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

interface RoundTripCase {
  readonly name: string;
  readonly bytes: Uint8Array;
}

function buildRoundTripCases(): RoundTripCase[] {
  // Deeply-nested structure (> a handful of levels).
  let nested: unknown = { leaf: 'end' };
  for (let i = 0; i < 40; i += 1) {
    nested = { level: i, child: nested };
  }

  // Large, highly-compressible binary payload (1 MiB of a single repeating byte).
  const largeBinary = new Uint8Array(1024 * 1024).fill(0x41);

  return [
    { name: 'empty bytes', bytes: new Uint8Array(0) },
    { name: 'empty object (encoded)', bytes: toBytes({}) },
    { name: 'empty string (encoded)', bytes: toBytes('') },
    { name: 'empty array (encoded)', bytes: toBytes([]) },
    {
      name: 'unicode content (encoded)',
      bytes: toBytes({ text: 'こんにちは 🌍 — naïve café ✓  \u{1F600}' }),
    },
    { name: 'deeply nested (encoded)', bytes: toBytes(nested) },
    { name: 'large repeating binary (1 MiB)', bytes: largeBinary },
  ];
}

describe('Compressor round-trip property table', () => {
  it.each(buildRoundTripCases())(
    'decompress(compress(bytes)) deep-equals the original ($name) with compression enabled',
    async ({ bytes }) => {
      // minSizeBytes:1 forces the compression path even for small inputs so the
      // round trip exercises gzip rather than the size-threshold passthrough.
      const config: CompressionConfig = { enabled: true, minSizeBytes: 1 };
      const codec = new Compressor(config);
      const decoded = await codec.decompress(await codec.compress(bytes));
      expect(decoded).toEqual(bytes);
    },
  ); // AC-15

  it.each(buildRoundTripCases())(
    'decompress(compress(bytes)) deep-equals the original ($name) under default threshold (passthrough)',
    async ({ bytes }) => {
      // Default minSizeBytes (1024): small inputs stay uncompressed, large ones
      // round-trip through gzip — either way the bytes must come back unchanged.
      const codec = new Compressor({ enabled: true });
      const decoded = await codec.decompress(await codec.compress(bytes));
      expect(decoded).toEqual(bytes);
    },
  ); // AC-15
});

describe('Compressor compression behavior', () => {
  it('prepends the LGC marker and shrinks a large compressible payload', async () => {
    const bytes = new Uint8Array(256 * 1024).fill(0x41);
    const codec = new Compressor({ enabled: true, minSizeBytes: 1 });
    const out = await codec.compress(bytes);

    // A highly-compressible 256 KiB payload must shrink and carry the marker.
    expect(out.byteLength).toBeLessThan(bytes.byteLength);
    expect(Compressor.hasCompressedMarker(out)).toBe(true);
    // The first three bytes are the 'LGC' marker.
    expect([out[0], out[1], out[2]]).toEqual([0x4c, 0x47, 0x43]);
  }); // AC-15

  it('returns the input unchanged when below minSizeBytes (threshold passthrough)', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const codec = new Compressor({ enabled: true, minSizeBytes: 1024 });
    const out = await codec.compress(bytes);
    // Below threshold: no marker, identical bytes returned.
    expect(out).toEqual(bytes);
    expect(Compressor.hasCompressedMarker(out)).toBe(false);
  }); // AC-15

  it('returns the input unchanged when compression would not save enough space', async () => {
    // High-entropy (incompressible) bytes from a deterministic xorshift32 PRNG:
    // gzip + marker is NOT < 90% of the original, so compress() returns the
    // original bytes unchanged (no marker). A periodic/low-entropy sequence here
    // would compress and wrongly exercise the marker path — entropy is the point.
    const bytes = new Uint8Array(2048);
    let state = 0x9e3779b9 >>> 0;
    for (let i = 0; i < bytes.length; i += 1) {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      bytes[i] = state & 0xff;
    }
    const codec = new Compressor({ enabled: true, minSizeBytes: 1 });
    const out = await codec.compress(bytes);
    expect(out).toEqual(bytes);
    expect(Compressor.hasCompressedMarker(out)).toBe(false);
  }); // AC-15
});

describe('Compressor decompress detection', () => {
  it('passes through bytes that carry neither the LGC marker nor the gzip magic', async () => {
    const bytes = new Uint8Array([0x00, 0x10, 0x20, 0x30]);
    const codec = new Compressor({ enabled: true });
    expect(await codec.decompress(bytes)).toEqual(bytes);
  }); // AC-15

  it('decompresses a legacy raw-gzip payload (no LGC marker) via the gzip-magic fallback', async () => {
    const original = new Uint8Array(4096).fill(0x42);
    const legacy = new Uint8Array(gzipSync(original));
    // Legacy payloads start with the gzip magic 0x1f 0x8b and have no LGC marker.
    expect(Compressor.isGzipped(legacy)).toBe(true);
    expect(Compressor.hasCompressedMarker(legacy)).toBe(false);
    const codec = new Compressor({ enabled: true });
    expect(await codec.decompress(legacy)).toEqual(original);
  }); // AC-15

  it('throws the gzip-bomb refusal error when output would exceed maxDecompressedBytes', async () => {
    // Compress a payload larger than the configured decompression cap so gunzip
    // hits maxOutputLength and the codec re-throws the documented refusal error.
    const big = new Uint8Array(64 * 1024).fill(0x43);
    const writer = new Compressor({ enabled: true, minSizeBytes: 1 });
    const compressed = await writer.compress(big);

    const reader = new Compressor({ enabled: true, maxDecompressedBytes: 1024 });
    await expect(reader.decompress(compressed)).rejects.toThrow(
      'Refusing to decompress payload: decompressed output would exceed 1024 bytes',
    );
  }); // AC-15
});

describe('Compressor static detectors', () => {
  it('hasCompressedMarker is true only for the exact LGC prefix', () => {
    expect(Compressor.hasCompressedMarker(new Uint8Array([0x4c, 0x47, 0x43, 0x00]))).toBe(true);
    // Wrong third byte, and a too-short buffer, are both rejected.
    expect(Compressor.hasCompressedMarker(new Uint8Array([0x4c, 0x47, 0x00]))).toBe(false);
    expect(Compressor.hasCompressedMarker(new Uint8Array([0x4c, 0x47]))).toBe(false);
  }); // AC-15

  it('isGzipped is true only for the gzip magic prefix 0x1f 0x8b', () => {
    expect(Compressor.isGzipped(new Uint8Array([0x1f, 0x8b, 0x08]))).toBe(true);
    expect(Compressor.isGzipped(new Uint8Array([0x1f, 0x00]))).toBe(false);
    expect(Compressor.isGzipped(new Uint8Array([0x1f]))).toBe(false);
  }); // AC-15
});
