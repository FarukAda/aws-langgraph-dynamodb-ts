import { MAX_S3_KEY_BYTES } from '../../constants';
import { ValidationError } from '../../errors/errors';
import type { S3ClientConfigLike, S3ClientLike } from './client-types';
import { encodeKeyPart } from './key-scope';

/** Configuration for offloading large payloads to S3. */
export interface S3OffloadConfig {
  bucketName: string;
  keyPrefix?: string;
  /**
   * Serialized payloads at or above this size are offloaded (default 350 KB).
   * Only the payload counts: the store's inline embedding (about 10 bytes per
   * dimension, so ~10 KB at 1024 dims and ~45 KB at 4096) lives on the same
   * item and is not part of it, so keep `thresholdBytes` plus the embedding
   * under DynamoDB's 400 KB item limit or the put fails with a raw
   * `ValidationException`.
   */
  thresholdBytes?: number;
  serverSideEncryption?: string;
  sseKmsKeyId?: string;
  /** Largest object this adapter will buffer from S3 (default 50 MiB). */
  maxDownloadBytes?: number;
  /**
   * S3 client configuration (an `S3ClientConfig`). `region` defaults to the
   * adapter's DynamoDB region.
   */
  clientConfig?: S3ClientConfigLike;
  /**
   * @internal Test seam and dependency-injection hook for constructing the
   * S3 client; not part of the supported surface and absent from the
   * shipped declarations.
   */
  createS3Client?: (config: S3ClientConfigLike) => S3ClientLike;
}

/**
 * Build a fully-qualified S3 key: `${prefix}${parts, each base64url-encoded,
 * joined with '/'}/${hash}.bin`.
 *
 * `parts` are the identity of the DynamoDB row that will point at the object,
 * and they are encoded rather than rejected: a namespace element or key may
 * contain '/' (only the DynamoDB '#' separator is forbidden at the validation
 * layer), and base64url's output alphabet never contains '/', so two distinct
 * `parts` arrays can never compose one key.
 *
 * `hash` is the content address of the bytes and is appended verbatim — it is
 * already base64url. Putting the row above the hash means an object belongs to
 * exactly one row, which is what lets that row delete it without consulting
 * anything else.
 *
 * Accepts: `prefix` — the offloader's, already validated and separator-
 * terminated. `parts` — at least one; the identity of the row that will point
 * at the object. `hash` — a content address from `contentHash`.
 *
 * Returns: the key. Two distinct `(prefix, parts, hash)` triples never compose
 * one key, and the same triple always composes the same one.
 *
 * Throws: ValidationError naming `s3Key` for an empty `parts` — an object with
 * no row above it is outside every row's scope and could never be read back —
 * and for a key over the 1024-byte cap. The encoding grows every part by a
 * third, so identifiers that each pass their own length rule can still compose
 * a key S3 would reject with a raw error.
 */
export function buildS3Key(prefix: string, parts: readonly string[], hash: string): string {
  if (parts.length === 0) {
    throw new ValidationError(
      'an offloaded object needs the identity of the row that points at it; parts was empty',
      's3Key',
    );
  }
  const encoded = [...parts.map(encodeKeyPart), hash];
  const key = `${prefix}${encoded.join('/')}.bin`;
  const bytes = Buffer.byteLength(key, 'utf8');
  if (bytes > MAX_S3_KEY_BYTES) {
    throw new ValidationError(
      `the offloaded S3 object key would be ${bytes} bytes; S3 caps keys at ` +
        `${MAX_S3_KEY_BYTES} — shorten the identifiers or the keyPrefix`,
      's3Key',
    );
  }
  return key;
}

/**
 * Refuse a key prefix that does not scope what it is used for.
 *
 * Accepts: `keyPrefix` — must be a string, non-empty, not `/`, and end in `/`.
 * The type is checked here, before any string method is called, so every
 * caller gets it: a number or `null` escaped as a bare `TypeError` from
 * `keyPrefix.endsWith`.
 *
 * Returns: nothing; acceptance is the absence of a throw.
 *
 * Throws: ValidationError naming `s3.keyPrefix`.
 *
 * Guarantees: the prefix scopes both the objects and the lifecycle rule built
 * from it. An empty or root prefix would make that rule expire the whole
 * bucket, and one without a trailing `/` (`app/langgraph`) would also match
 * every sibling starting with the same characters (`app/langgraph-other/`).
 */
export function assertScopedKeyPrefix(keyPrefix: string): void {
  if (
    typeof keyPrefix !== 'string' ||
    keyPrefix === '' ||
    keyPrefix === '/' ||
    !keyPrefix.endsWith('/')
  ) {
    throw new ValidationError(
      's3.keyPrefix must be a non-empty path that ends with "/" (for example "langgraph/"): ' +
        'it scopes both the offloaded objects and the S3 lifecycle rule',
      's3.keyPrefix',
    );
  }
}

/**
 * The lifecycle rule id for `prefix`: `langgraph-ttl-` plus its slug.
 *
 * Accepts: `prefix` — any string; trailing slashes are trimmed, and every
 * character outside `[A-Za-z0-9-]` becomes `-`.
 *
 * Returns: a deterministic id that does not change with the TTL, so raising or
 * lowering the TTL updates one rule rather than adding another. A prefix with
 * no usable characters yields `langgraph-ttl-default`.
 *
 * Throws: nothing.
 *
 * Guarantees: the slug is not injective — `a/b/` and `a-b/` produce one id —
 * and `ensureLifecycleRule` refuses rather than take over a rule that a
 * different prefix already holds.
 */
export function buildLifecycleRuleId(prefix: string): string {
  let trimmed = prefix;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  const slug = trimmed.replace(/[^a-zA-Z0-9-]/g, '-') || 'default';
  return `langgraph-ttl-${slug}`;
}

/**
 * An adapter's default S3 key prefix.
 *
 * Accepts: `base` — the shared prefix, ending in `/`. `adapter` — the adapter's
 * own segment.
 *
 * Returns: `base` + `adapter` + `/`, so three adapters sharing one bucket write
 * under three paths and one adapter's lifecycle rule never sweeps another's
 * objects.
 *
 * Throws: nothing.
 */
export function defaultAdapterKeyPrefix(base: string, adapter: string): string {
  return `${base}${adapter}/`;
}
