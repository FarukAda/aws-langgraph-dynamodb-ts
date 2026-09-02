import { MAX_INLINE_PAYLOAD_BYTES } from '../constants';
import { ValidationError } from '../errors/errors';
import {
  type CodecDeps,
  DESCRIPTOR_SCHEMA_VERSION,
  type PayloadDescriptor,
  PayloadLocation,
} from './codec';
import { type CompressionResult, compress } from './compression';

/** Options controlling where an offloaded payload's S3 key is built from. */
export interface EncodeOptions {
  keyParts: readonly string[];
}

/**
 * Reject bytes that cannot be stored inline. Without an offloader the only
 * alternative is a raw `ValidationException` from DynamoDB after the network
 * round trip, which names neither the cause nor the remedy.
 */
function assertInlinePayloadFits(bytes: Uint8Array, deps: CodecDeps): void {
  if (bytes.length <= MAX_INLINE_PAYLOAD_BYTES) return;
  const hint = deps.compression?.enabled
    ? ''
    : ', or enable compression if the data compresses well';
  throw new ValidationError(
    `payload of ${bytes.length} bytes exceeds the ${MAX_INLINE_PAYLOAD_BYTES}-byte inline limit ` +
      `(DynamoDB items are capped at 400 KB); configure s3 offloading${hint}`,
    'payload',
  );
}

/**
 * Encode `value`: serialize via serde, compress (if configured), then offload
 * to S3 when the compressed bytes exceed the offloader's threshold. Returns a
 * descriptor recording how to read it back. Without an offloader, bytes that
 * cannot fit a DynamoDB item are rejected here (see
 * {@link assertInlinePayloadFits}).
 */
export async function encodePayload<T>(
  value: T,
  deps: CodecDeps,
  options: EncodeOptions,
): Promise<PayloadDescriptor> {
  const [serdeType, raw] = await deps.serde.dumpsTyped(value);
  const { bytes, compressed }: CompressionResult = deps.compression
    ? await compress(raw, deps.compression)
    : { bytes: raw, compressed: false };
  const base = { schemaVersion: DESCRIPTOR_SCHEMA_VERSION, serdeType, compressed };
  if (deps.offloader && deps.offloader.shouldOffload(bytes)) {
    const s3Key = deps.offloader.buildKey(options.keyParts);
    await deps.offloader.upload(s3Key, bytes);
    return { ...base, location: PayloadLocation.S3, s3Key };
  }
  if (!deps.offloader) assertInlinePayloadFits(bytes, deps);
  return { ...base, location: PayloadLocation.INLINE, bytes };
}
