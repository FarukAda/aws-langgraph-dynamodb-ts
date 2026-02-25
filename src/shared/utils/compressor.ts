/**
 * Checkpoint compression utility using Node.js built-in zlib
 * Provides transparent gzip compression/decompression with smart thresholds
 */

import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Gzip magic number bytes for auto-detection */
const GZIP_MAGIC = new Uint8Array([0x1f, 0x8b]);

/**
 * Configuration for checkpoint compression
 */
export interface CompressionConfig {
  /** Whether compression is enabled (default: false) */
  enabled: boolean;
  /** Minimum payload size in bytes to trigger compression (default: 1024 = 1KB) */
  minSizeBytes?: number;
  /** Gzip compression level 1-9 (default: 6 = balanced speed/ratio) */
  level?: number;
}

/**
 * Compressor for checkpoint data using gzip
 *
 * Features:
 * - Smart threshold: skips compression for payloads below `minSizeBytes`
 * - Auto-detection: `decompress()` transparently handles both compressed and uncompressed data
 * - Zero dependencies: uses Node.js built-in `zlib`
 */
export class Compressor {
  private readonly minSizeBytes: number;
  private readonly level: number;

  constructor(config: CompressionConfig) {
    this.minSizeBytes = config.minSizeBytes ?? 1024;
    this.level = config.level ?? 6;
  }

  /**
   * Compress data if above the minimum size threshold
   *
   * @param data - Raw data to compress
   * @returns Compressed data (gzip) or original data if below threshold
   */
  async compress(data: Uint8Array): Promise<Uint8Array> {
    if (data.length < this.minSizeBytes) {
      return data;
    }

    const compressed = new Uint8Array(await gzipAsync(data, { level: this.level }));

    // Only use compressed output if it saves at least 10% space.
    // This avoids data expansion for already-compressed or random binary payloads.
    if (compressed.length >= data.length * 0.9) {
      return data;
    }

    return compressed;
  }

  /**
   * Decompress data if gzip magic header is detected, otherwise passthrough
   * This provides full backward compatibility with uncompressed data
   *
   * @param data - Potentially compressed data
   * @returns Decompressed data
   */
  async decompress(data: Uint8Array): Promise<Uint8Array> {
    if (!Compressor.isGzipped(data)) {
      return data;
    }

    return new Uint8Array(await gunzipAsync(data));
  }

  /**
   * Check if data starts with the gzip magic number
   */
  static isGzipped(data: Uint8Array): boolean {
    return data.length >= 2 && data[0] === GZIP_MAGIC[0] && data[1] === GZIP_MAGIC[1];
  }
}
