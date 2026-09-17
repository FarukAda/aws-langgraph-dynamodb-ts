import { MAX_INLINE_PAYLOAD_BYTES } from '../constants';
import { ValidationError } from '../errors/errors';
import {
  type CodecDeps,
  DESCRIPTOR_SCHEMA_VERSION,
  type PayloadDescriptor,
  PayloadLocation,
} from './codec';
import { type CompressionResult, compress } from './compression';

/** The DynamoDB key of the row that will hold the descriptor being built. */
interface RowKey {
  pk: string;
  sk: string;
}

/** Options controlling where an offloaded payload's S3 key is built from. */
export interface EncodeOptions {
  /**
   * The identity of the row this payload belongs to, as the path segments
   * above {@link EncodeOptions.objectId}. A reader refuses an object that lies
   * outside the path its row's leading identifiers produce.
   */
  keyParts: readonly string[];
  /**
   * The id of the write this payload belongs to, and the key's last segment.
   * The caller draws a fresh UUID or ULID for each write — each store put, each
   * checkpoint put, each `putWrites` call, each history message — and passes the
   * same one for every payload of that write, whose `keyParts` already differ.
   * No other write uses that id, so no row another write commits names the
   * object.
   */
  objectId: string;
  /**
   * The row's DynamoDB key, stored on the object as the backlink AWS
   * recommends for exactly this layout: "Store the primary key value of the
   * item as Amazon S3 metadata of the object" (*Best practices for storing
   * large items and attributes in DynamoDB*). Nothing in this package reads it
   * back; it exists so an out-of-band sweeper can ask DynamoDB whether an
   * object's parent row still exists without parsing object keys.
   */
  row: RowKey;
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
 * The descriptor recording how to read `value` back: serialized, compressed if
 * configured, and offloaded to S3 if large enough.
 *
 * Accepts: `value` — anything the serde can represent; what it cannot is its
 * own error. `deps.compression` — absent or `enabled: false` stores the
 * serialized bytes as they are. `deps.offloader` — absent stores every payload
 * inline. `options` — the row's identity, the write's object id and the row's
 * DynamoDB key (see {@link EncodeOptions}).
 *
 * Returns: an `S3` descriptor when an offloader is configured and
 * `shouldOffload` accepts the compressed size, otherwise an `INLINE`
 * descriptor carrying the bytes. Both record `serdeType` and `compressed`, so
 * neither is ever inferred from the bytes on read.
 *
 * Throws: whatever `serde.dumpsTyped` throws; `S3_OFFLOAD_FAILED` from the
 * upload; and ValidationError naming `payload` when there is **no** offloader
 * and the bytes exceed `MAX_INLINE_PAYLOAD_BYTES`. With an offloader that cell
 * cannot arise: `s3.thresholdBytes` is itself capped at that limit
 * (`src/shared/validation/codec-options.ts`, `validateS3`), so bytes too large
 * to store inline are always at or above the threshold and offload instead.
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
    const s3Key = deps.offloader.buildKey(options.keyParts, options.objectId);
    await deps.offloader.upload(s3Key, bytes, options.row);
    return { ...base, location: PayloadLocation.S3, s3Key };
  }
  if (!deps.offloader) assertInlinePayloadFits(bytes, deps);
  return { ...base, location: PayloadLocation.INLINE, bytes };
}
