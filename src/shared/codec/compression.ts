import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

import {
  DEFAULT_COMPRESSION_LEVEL,
  DEFAULT_COMPRESSION_MIN_BYTES,
  DEFAULT_MAX_DECOMPRESSED_BYTES,
} from '../constants';
import { DynamoDbLangGraphError } from '../errors/base-error';
import { ErrorCode } from '../errors/error-code';
import { COMPRESSED_MARKER, hasCompressedMarker, isGzipped } from './compression-markers';

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

/**
 * Gzip `data` when it is at least `minSizeBytes` and compression actually saves
 * space (after the 3-byte marker). Returns the original buffer otherwise. The
 * output carries the LGC marker so {@link decompress} can identify it.
 */
export async function compress(data: Uint8Array, config: CompressionConfig): Promise<Uint8Array> {
  const minSize = config.minSizeBytes ?? DEFAULT_COMPRESSION_MIN_BYTES;
  if (!config.enabled || data.length < minSize) return data;
  const level = config.level ?? DEFAULT_COMPRESSION_LEVEL;
  const gzipped = new Uint8Array(await gzipAsync(data, { level }));
  if (gzipped.length + COMPRESSED_MARKER.length >= data.length * COMPRESSION_GAIN_RATIO)
    return data;
  const out = new Uint8Array(COMPRESSED_MARKER.length + gzipped.length);
  out.set(COMPRESSED_MARKER, 0);
  out.set(gzipped, COMPRESSED_MARKER.length);
  return out;
}

/**
 * Decompress `data` if it is library-compressed (LGC marker) or legacy gzip;
 * otherwise return it unchanged. Throws a {@link DynamoDbLangGraphError} with
 * code `COMPRESSION_LIMIT` if the output would exceed `maxBytes` (bomb guard).
 */
export async function decompress(
  data: Uint8Array,
  maxBytes: number = DEFAULT_MAX_DECOMPRESSED_BYTES,
): Promise<Uint8Array> {
  const options = { maxOutputLength: maxBytes };
  try {
    if (hasCompressedMarker(data)) {
      return new Uint8Array(await gunzipAsync(data.subarray(COMPRESSED_MARKER.length), options));
    }
    if (isGzipped(data)) {
      return new Uint8Array(await gunzipAsync(data, options));
    }
    return data;
  } catch (error) {
    const err = error as { code?: string };
    if (err.code === 'ERR_BUFFER_TOO_LARGE') {
      throw new DynamoDbLangGraphError(
        `Refusing to decompress: output would exceed ${maxBytes} bytes`,
        ErrorCode.COMPRESSION_LIMIT,
        {},
        error as Error,
      );
    }
    throw error;
  }
}
