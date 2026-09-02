import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

import {
  DEFAULT_COMPRESSION_LEVEL,
  DEFAULT_COMPRESSION_MIN_BYTES,
  DEFAULT_MAX_DECOMPRESSED_BYTES,
} from '../constants';
import { DynamoDBLangGraphError } from '../errors/base-error';
import { ErrorCode } from '../errors/error-code';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Minimum fraction of the original size the gzip output must beat to be kept. */
const COMPRESSION_GAIN_RATIO = 0.9;

/** Configuration for payload compression. */
export interface CompressionConfig {
  enabled: boolean;
  minSizeBytes?: number;
  level?: number;
  maxDecompressedBytes?: number;
}

/** The bytes to store plus whether they were gzip-compressed. */
export interface CompressionResult {
  bytes: Uint8Array;
  compressed: boolean;
}

/**
 * Gzip `data` when it is at least `minSizeBytes` and compression actually saves
 * space. Returns the bytes to store and a `compressed` flag the caller records
 * in the payload descriptor; compression is never inferred from the bytes.
 */
export async function compress(
  data: Uint8Array,
  config: CompressionConfig,
): Promise<CompressionResult> {
  const minSize = config.minSizeBytes ?? DEFAULT_COMPRESSION_MIN_BYTES;
  if (!config.enabled || data.length < minSize) return { bytes: data, compressed: false };
  const level = config.level ?? DEFAULT_COMPRESSION_LEVEL;
  const gzipped = new Uint8Array(await gzipAsync(data, { level }));
  if (gzipped.length >= data.length * COMPRESSION_GAIN_RATIO) {
    return { bytes: data, compressed: false };
  }
  return { bytes: gzipped, compressed: true };
}

/**
 * Gunzip `data` when `compressed` is true; otherwise return it unchanged. Throws
 * a {@link DynamoDBLangGraphError} with code `COMPRESSION_LIMIT` if the output
 * would exceed `maxBytes` (bomb guard).
 */
export async function decompress(
  data: Uint8Array,
  compressed: boolean,
  maxBytes: number = DEFAULT_MAX_DECOMPRESSED_BYTES,
): Promise<Uint8Array> {
  if (!compressed) return data;
  try {
    return new Uint8Array(await gunzipAsync(data, { maxOutputLength: maxBytes }));
  } catch (error) {
    const err = error as { code?: string };
    if (err.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new DynamoDBLangGraphError(
        `Refusing to decompress: output would exceed ${maxBytes} bytes`,
        ErrorCode.COMPRESSION_LIMIT,
        {},
        error as Error,
      );
    }
    throw error;
  }
}
