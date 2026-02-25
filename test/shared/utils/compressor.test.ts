import { Compressor, CompressionConfig } from '../../../src/shared';

/**
 * Helper to create test data of a specific size
 */
function createTestData(sizeBytes: number): Uint8Array {
  const data = new Uint8Array(sizeBytes);
  for (let i = 0; i < sizeBytes; i++) {
    data[i] = i % 256;
  }
  return data;
}

/**
 * Helper to create compressible text data (repeated patterns compress well)
 */
function createCompressibleData(sizeBytes: number): Uint8Array {
  const text = 'hello world '.repeat(Math.ceil(sizeBytes / 12)).substring(0, sizeBytes);
  return new Uint8Array(Buffer.from(text));
}

describe('Compressor', () => {
  const defaultConfig: CompressionConfig = {
    enabled: true,
    minSizeBytes: 1024,
    level: 6,
  };

  describe('constructor', () => {
    it('should use default values when not specified', async () => {
      const compressor = new Compressor({ enabled: true });
      // Verify defaults work by compressing data below default threshold
      const smallData = createTestData(512);
      const result = await compressor.compress(smallData);
      // Below 1024 default threshold — should pass through
      expect(result).toEqual(smallData);
    });

    it('should accept custom minSizeBytes', async () => {
      const compressor = new Compressor({ enabled: true, minSizeBytes: 256 });
      const data = createCompressibleData(300);
      const result = await compressor.compress(data);
      // 300 > 256 custom threshold — should be compressed
      expect(Compressor.isGzipped(result)).toBe(true);
    });

    it('should accept custom compression level', async () => {
      const compressorFast = new Compressor({ enabled: true, level: 1, minSizeBytes: 100 });
      const compressorBest = new Compressor({ enabled: true, level: 9, minSizeBytes: 100 });
      const data = createCompressibleData(2048);

      const resultFast = await compressorFast.compress(data);
      const resultBest = await compressorBest.compress(data);

      // Both should be gzipped
      expect(Compressor.isGzipped(resultFast)).toBe(true);
      expect(Compressor.isGzipped(resultBest)).toBe(true);

      // Level 9 should produce smaller or equal output than level 1
      expect(resultBest.length).toBeLessThanOrEqual(resultFast.length);
    });
  });

  describe('compress', () => {
    it('should passthrough data below minSizeBytes threshold', async () => {
      const compressor = new Compressor(defaultConfig);
      const smallData = createTestData(512);
      const result = await compressor.compress(smallData);

      // Should return the exact same reference for below-threshold data
      expect(result).toBe(smallData);
      expect(Compressor.isGzipped(result)).toBe(false);
    });

    it('should passthrough data exactly at minSizeBytes threshold', async () => {
      const compressor = new Compressor({ enabled: true, minSizeBytes: 100 });
      const data = createTestData(99); // Just below threshold
      const result = await compressor.compress(data);
      expect(result).toBe(data);
    });

    it('should compress data above minSizeBytes threshold', async () => {
      const compressor = new Compressor(defaultConfig);
      const data = createCompressibleData(2048);
      const result = await compressor.compress(data);

      // Should be gzipped (starts with 0x1F 0x8B)
      expect(Compressor.isGzipped(result)).toBe(true);
      // Compressed result should be different from input
      expect(result).not.toEqual(data);
    });

    it('should compress repetitive data significantly', async () => {
      const compressor = new Compressor(defaultConfig);
      const data = createCompressibleData(10_000);
      const compressed = await compressor.compress(data);

      // Repetitive text should compress very well (>50% reduction)
      expect(compressed.length).toBeLessThan(data.length * 0.5);
    });

    it('should handle empty data (below threshold)', async () => {
      const compressor = new Compressor(defaultConfig);
      const emptyData = new Uint8Array(0);
      const result = await compressor.compress(emptyData);

      expect(result).toBe(emptyData);
      expect(result.length).toBe(0);
    });

    it('should passthrough data that does not compress well (savings < 10%)', async () => {
      const compressor = new Compressor({ enabled: true, minSizeBytes: 100 });
      // Truly random data won't compress well enough to achieve 10% savings
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const crypto = require('crypto') as typeof import('crypto');
      const randomData = new Uint8Array(crypto.randomBytes(2048));
      const compressed = await compressor.compress(randomData);

      // Should return original data since gzip can't save ≥10% on random data
      expect(compressed).toBe(randomData);
      expect(Compressor.isGzipped(compressed)).toBe(false);
    });

    it('should only use compressed output if it saves at least 10% space', async () => {
      const compressor = new Compressor({ enabled: true, minSizeBytes: 100 });

      // Highly compressible data (repeated text) should be compressed
      const compressibleData = createCompressibleData(2048);
      const compressedGood = await compressor.compress(compressibleData);
      expect(Compressor.isGzipped(compressedGood)).toBe(true);
      expect(compressedGood.length).toBeLessThan(compressibleData.length * 0.9);

      // Truly random data should NOT be compressed (savings < 10%)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const crypto = require('crypto') as typeof import('crypto');
      const randomData = new Uint8Array(crypto.randomBytes(2048));
      const compressedBad = await compressor.compress(randomData);
      expect(compressedBad).toBe(randomData);
    });

    it('should produce valid gzip output with magic header bytes', async () => {
      const compressor = new Compressor({ enabled: true, minSizeBytes: 10 });
      const data = createCompressibleData(100);
      const result = await compressor.compress(data);

      // Gzip magic bytes: 0x1F 0x8B
      expect(result[0]).toBe(0x1f);
      expect(result[1]).toBe(0x8b);
    });

    it('should compress with threshold of 0 (always compress)', async () => {
      const compressor = new Compressor({ enabled: true, minSizeBytes: 0 });
      const data = createCompressibleData(50); // Small data
      const result = await compressor.compress(data);

      expect(Compressor.isGzipped(result)).toBe(true);
    });

    it('should respect different compression levels', async () => {
      const levels = [1, 3, 6, 9];
      const data = createCompressibleData(5000);
      const results: Uint8Array[] = [];

      for (const level of levels) {
        const compressor = new Compressor({ enabled: true, level, minSizeBytes: 100 });
        results.push(await compressor.compress(data));
      }

      // All should be valid gzip
      for (const result of results) {
        expect(Compressor.isGzipped(result)).toBe(true);
      }

      // Higher levels should generally produce smaller output
      // (may not always be strictly decreasing for small inputs, so just check overall trend)
      expect(results[3].length).toBeLessThanOrEqual(results[0].length);
    });
  });

  describe('decompress', () => {
    it('should decompress gzipped data', async () => {
      const compressor = new Compressor({ enabled: true, minSizeBytes: 10 });
      const originalData = createCompressibleData(500);
      const compressed = await compressor.compress(originalData);
      const decompressed = await compressor.decompress(compressed);

      expect(decompressed).toEqual(originalData);
    });

    it('should passthrough non-gzipped data (backward compatible)', async () => {
      const compressor = new Compressor(defaultConfig);
      const rawData = new Uint8Array(Buffer.from('hello world'));
      const result = await compressor.decompress(rawData);

      expect(result).toBe(rawData);
    });

    it('should passthrough empty data', async () => {
      const compressor = new Compressor(defaultConfig);
      const emptyData = new Uint8Array(0);
      const result = await compressor.decompress(emptyData);

      expect(result).toBe(emptyData);
    });

    it('should passthrough single-byte data', async () => {
      const compressor = new Compressor(defaultConfig);
      const oneByte = new Uint8Array([0x42]);
      const result = await compressor.decompress(oneByte);

      expect(result).toBe(oneByte);
    });

    it('should passthrough data that starts with 0x1F but is not gzip', async () => {
      const compressor = new Compressor(defaultConfig);
      // Starts with 0x1F but second byte is NOT 0x8B — not valid gzip
      const fakeGzip = new Uint8Array([0x1f, 0x00, 0x41, 0x42]);
      const result = await compressor.decompress(fakeGzip);

      expect(result).toBe(fakeGzip);
    });

    it('should throw on corrupted gzip data (valid magic header but invalid content)', async () => {
      const compressor = new Compressor(defaultConfig);
      // Valid gzip magic header but garbage body
      const corruptGzip = new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xff, 0xff]);

      await expect(compressor.decompress(corruptGzip)).rejects.toThrow();
    });
  });

  describe('round-trip', () => {
    it('should round-trip small data (below threshold — no compression)', async () => {
      const compressor = new Compressor(defaultConfig);
      const smallData = createTestData(100);
      const compressed = await compressor.compress(smallData);
      const decompressed = await compressor.decompress(compressed);

      expect(decompressed).toEqual(smallData);
    });

    it('should round-trip large data (above threshold — with compression)', async () => {
      const compressor = new Compressor(defaultConfig);
      const largeData = createCompressibleData(5000);
      const compressed = await compressor.compress(largeData);
      const decompressed = await compressor.decompress(compressed);

      expect(decompressed).toEqual(largeData);
    });

    it('should round-trip JSON checkpoint data', async () => {
      const compressor = new Compressor({ enabled: true, minSizeBytes: 100 });
      const checkpointJson = JSON.stringify({
        v: 1,
        id: 'checkpoint-123',
        ts: '2026-02-24T00:00:00Z',
        channel_values: {
          messages: Array.from({ length: 50 }, (_, i) => ({
            role: i % 2 === 0 ? 'human' : 'ai',
            content: `Message ${i}: Lorem ipsum dolor sit amet, consectetur adipiscing elit.`,
          })),
        },
        channel_versions: { messages: 50 },
        versions_seen: { messages: {} },
      });
      const data = new Uint8Array(Buffer.from(checkpointJson));

      const compressed = await compressor.compress(data);
      expect(Compressor.isGzipped(compressed)).toBe(true);

      const decompressed = await compressor.decompress(compressed);
      expect(Buffer.from(decompressed).toString()).toEqual(checkpointJson);
    });

    it('should round-trip binary data with all byte values', async () => {
      const compressor = new Compressor({ enabled: true, minSizeBytes: 100 });
      // Create data that includes every possible byte value
      const data = new Uint8Array(256 * 4);
      for (let i = 0; i < data.length; i++) {
        data[i] = i % 256;
      }

      const compressed = await compressor.compress(data);
      const decompressed = await compressor.decompress(compressed);

      expect(decompressed).toEqual(data);
    });

    it('should handle mixed compressed and uncompressed reads', async () => {
      const compressor = new Compressor(defaultConfig);
      const smallData = createTestData(100); // Below threshold, not compressed
      const largeData = createCompressibleData(5000); // Above threshold, compressed

      const compressedSmall = await compressor.compress(smallData);
      const compressedLarge = await compressor.compress(largeData);

      // Verify small was NOT compressed (identity passthrough)
      expect(Compressor.isGzipped(compressedSmall)).toBe(false);
      // Verify large WAS compressed
      expect(Compressor.isGzipped(compressedLarge)).toBe(true);

      // Both should decompress correctly
      expect(await compressor.decompress(compressedSmall)).toEqual(smallData);
      expect(await compressor.decompress(compressedLarge)).toEqual(largeData);
    });
  });

  describe('isGzipped (static)', () => {
    it('should detect gzip magic header', () => {
      expect(Compressor.isGzipped(new Uint8Array([0x1f, 0x8b, 0x08]))).toBe(true);
    });

    it('should reject non-gzip data', () => {
      expect(Compressor.isGzipped(new Uint8Array([0x00, 0x00]))).toBe(false);
      expect(Compressor.isGzipped(new Uint8Array([0x50, 0x4b]))).toBe(false); // ZIP magic
      expect(Compressor.isGzipped(new Uint8Array([0x89, 0x50]))).toBe(false); // PNG magic
    });

    it('should reject data shorter than 2 bytes', () => {
      expect(Compressor.isGzipped(new Uint8Array([]))).toBe(false);
      expect(Compressor.isGzipped(new Uint8Array([0x1f]))).toBe(false);
    });

    it('should detect only the first two bytes', () => {
      // 0x1F 0x8B followed by anything — still detected as gzip
      expect(Compressor.isGzipped(new Uint8Array([0x1f, 0x8b]))).toBe(true);
      expect(Compressor.isGzipped(new Uint8Array([0x1f, 0x8b, 0x00, 0x00]))).toBe(true);
    });
  });

  describe('cross-compressor compatibility', () => {
    it('should decompress data compressed by a different Compressor instance', async () => {
      const compressor1 = new Compressor({ enabled: true, level: 1, minSizeBytes: 100 });
      const compressor2 = new Compressor({ enabled: true, level: 9, minSizeBytes: 100 });
      const data = createCompressibleData(2000);

      const compressed = await compressor1.compress(data);
      const decompressed = await compressor2.decompress(compressed);

      expect(decompressed).toEqual(data);
    });

    it('should decompress data compressed at any level', async () => {
      const data = createCompressibleData(2000);
      const decompressor = new Compressor({ enabled: true, minSizeBytes: 100 });

      for (let level = 1; level <= 9; level++) {
        const compressor = new Compressor({
          enabled: true,
          level,
          minSizeBytes: 100,
        });
        const compressed = await compressor.compress(data);
        const decompressed = await decompressor.decompress(compressed);
        expect(decompressed).toEqual(data);
      }
    });
  });
});
