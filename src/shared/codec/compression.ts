/**
 * Hides whether a stored payload's bytes are gzipped.
 *
 * When gzip is attempted, when its output is not worth keeping, and how a read
 * refuses a gzip bomb or a stream that is not gzip are decided here. A caller
 * carries only the flag this module returns, recorded beside the bytes, so
 * compression is never guessed from the bytes and the thresholds can change
 * without touching the codec that stores them.
 */

import { promisify } from 'node:util';
import { gunzip, gzip } from 'node:zlib';

import { DynamoDBLangGraphError } from '../errors/base-error';
import { ErrorCode } from '../errors/error-code';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

/** Minimum fraction of the original size the gzip output must beat to be kept. */
const COMPRESSION_GAIN_RATIO = 0.9;

/** Default minimum payload size before gzip compression is attempted. */
export const DEFAULT_COMPRESSION_MIN_BYTES = 1024;

/** Default gzip compression level (balanced speed/ratio). */
export const DEFAULT_COMPRESSION_LEVEL = 6;

/** Default gzip-bomb guard: maximum decompressed output (50 MiB). */
export const DEFAULT_MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024;

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
 * The bytes to store for `data`, gzipped when that is worth doing.
 *
 * Accepts: `data` — any length, including empty. `config.enabled` — `false`
 * returns the input untouched. `config.minSizeBytes` — the size below which
 * gzip is not attempted, default {@link DEFAULT_COMPRESSION_MIN_BYTES}.
 * `config.level` — zlib level 0–9, default {@link DEFAULT_COMPRESSION_LEVEL}.
 * `config.maxDecompressedBytes` is read on the way back, not here.
 *
 * Returns: `compressed: true` only when gzip beat the input by at least 10%;
 * otherwise the input bytes and `compressed: false`. The flag is recorded in
 * the payload descriptor, so compression is never inferred from the bytes on
 * read.
 *
 * Throws: whatever `zlib.gzip` rejects with.
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

/** The error a payload raises when its bytes are not the form its row declares. */
function corruptPayload(cause: Error): DynamoDBLangGraphError {
  return new DynamoDBLangGraphError(
    'the stored payload is marked compressed but is not valid gzip, so it cannot be decoded',
    ErrorCode.PAYLOAD_CORRUPT,
    {},
    cause,
  );
}

/**
 * The payload bytes `data` stands for, gunzipped when the row says so.
 *
 * Accepts: `data` — the bytes as stored. `compressed` — the descriptor's own
 * flag; `false` returns `data` unchanged and inspects nothing. `maxBytes` — the
 * decompressed-output cap, default {@link DEFAULT_MAX_DECOMPRESSED_BYTES}; a
 * reader that configures no compression uses that default whatever the writer
 * used.
 *
 * Returns: the decoded bytes.
 *
 * Throws: `COMPRESSION_LIMIT` when the output would exceed `maxBytes`, and
 * `PAYLOAD_CORRUPT` when `compressed` is true but the bytes are not gzip. Both
 * are permanent for that payload ({@link isPermanentPayloadLoss}), so a caller
 * reports rather than retries.
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
    throw corruptPayload(error as Error);
  }
}
