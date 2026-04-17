/**
 * Checkpoint compression utility using Node.js built-in zlib
 * Provides transparent gzip compression/decompression with smart thresholds
 */

import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Gzip magic number bytes for auto-detection of legacy payloads */
const GZIP_MAGIC = new Uint8Array([0x1f, 0x8b]);

/**
 * 3-byte marker stamped at the start of new compressed payloads. Unambiguously
 * identifies "this is library-compressed" so we do not try to gunzip raw binary
 * that happens to start with the gzip magic bytes. Legacy payloads (pre-marker)
 * are still decompressed on a gzip-magic fallback — see `decompress()`.
 *
 * Bytes 0x4C 0x47 0x43 spell "LGC" (LangGraph-Compressed).
 */
const COMPRESSED_MARKER = new Uint8Array([0x4c, 0x47, 0x43]);

/**
 * Default maximum decompressed output size: 50 MiB.
 *
 * Guards against "gzip bomb" payloads that are small on disk / in DynamoDB but
 * expand to multi-gigabyte buffers that would OOM the process. Raise this via
 * `CompressionConfig.maxDecompressedBytes` only if a legitimate workload needs
 * larger checkpoints (remember: a DynamoDB item is hard-capped at 400 KB, so
 * values above this threshold must originate from S3 offloading and should be
 * treated with the same scrutiny).
 */
const DEFAULT_MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024;

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
  /**
   * Hard cap on decompressed output size in bytes (default: 50 MiB).
   * Protects against gzip-bomb payloads. Decompression throws if the output
   * would exceed this cap.
   */
  maxDecompressedBytes?: number;
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
  private readonly maxDecompressedBytes: number;

  constructor(config: CompressionConfig) {
    this.minSizeBytes = config.minSizeBytes ?? 1024;
    this.level = config.level ?? 6;
    this.maxDecompressedBytes = config.maxDecompressedBytes ?? DEFAULT_MAX_DECOMPRESSED_BYTES;
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

    // Only use compressed output if it saves enough space to pay for the 3-byte
    // marker overhead plus a reasonable margin (10%). Avoids data expansion for
    // already-compressed or random binary payloads.
    if (compressed.length + COMPRESSED_MARKER.length >= data.length * 0.9) {
      return data;
    }

    // Prepend the LGC marker so decompress() can unambiguously identify our output.
    const out = new Uint8Array(COMPRESSED_MARKER.length + compressed.length);
    out.set(COMPRESSED_MARKER, 0);
    out.set(compressed, COMPRESSED_MARKER.length);
    return out;
  }

  /**
   * Decompress data if it is library-compressed, otherwise passthrough.
   *
   * Detection order:
   *   1. LGC marker: new-format payloads produced by compress() above.
   *   2. Gzip magic: legacy payloads from before the marker was introduced;
   *      decompressed for backward compatibility.
   *
   * Raw user binary that happens to start with the gzip magic bytes is still at
   * risk under (2), but new writes use the marker and will be unambiguous.
   *
   * @param data - Potentially compressed data
   * @returns Decompressed data
   */
  async decompress(data: Uint8Array): Promise<Uint8Array> {
    // zlib rejects with an ERR_BUFFER_TOO_LARGE when the decompressed output
    // would exceed maxOutputLength — caps memory use on hostile gzip-bomb input.
    const opts = { maxOutputLength: this.maxDecompressedBytes };
    try {
      if (Compressor.hasCompressedMarker(data)) {
        const payload = data.subarray(COMPRESSED_MARKER.length);
        return new Uint8Array(await gunzipAsync(payload, opts));
      }
      if (Compressor.isGzipped(data)) {
        // Legacy, pre-marker payload
        return new Uint8Array(await gunzipAsync(data, opts));
      }
      return data;
    } catch (err) {
      if (
        err &&
        typeof err === 'object' &&
        (err as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE'
      ) {
        throw new Error(
          `Refusing to decompress payload: decompressed output would exceed ${this.maxDecompressedBytes} bytes. ` +
            `Raise Compressor's maxDecompressedBytes if this limit is too low.`,
          { cause: err },
        );
      }
      throw err;
    }
  }

  /**
   * Check if data carries the library's compression marker.
   */
  static hasCompressedMarker(data: Uint8Array): boolean {
    if (data.length < COMPRESSED_MARKER.length) return false;
    for (let i = 0; i < COMPRESSED_MARKER.length; i++) {
      if (data[i] !== COMPRESSED_MARKER[i]) return false;
    }
    return true;
  }

  /**
   * Check if data starts with the gzip magic number (legacy-format detection).
   */
  static isGzipped(data: Uint8Array): boolean {
    return data.length >= 2 && data[0] === GZIP_MAGIC[0] && data[1] === GZIP_MAGIC[1];
  }
}
