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
 * joined with '/'}.bin`. Encoding (not rejecting) is what makes two distinct
 * `parts` arrays never collide, since a namespace element or key is allowed
 * to contain '/' (only the DynamoDB '#' separator is forbidden at the
 * validation layer) and base64url's output alphabet never contains '/'.
 *
 * The produced key is checked against S3's 1024-byte object-key cap: the
 * encoding grows every part by a third, so identifiers that each pass their
 * own length rule can still compose a key S3 would reject with a raw error.
 */
export function buildS3Key(prefix: string, parts: readonly string[]): string {
  const encoded = parts.map(encodeKeyPart);
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
 * The key prefix doubles as the S3 lifecycle rule's `Filter.Prefix`. An empty
 * or root prefix would make that rule expire the whole bucket, and a prefix
 * without a trailing `/` (`app/langgraph`) would also match every sibling
 * object that merely starts with the same characters (`app/langgraph-other/`).
 */
export function assertScopedKeyPrefix(keyPrefix: string): void {
  if (keyPrefix === '' || keyPrefix === '/' || !keyPrefix.endsWith('/')) {
    throw new ValidationError(
      's3.keyPrefix must be a non-empty path that ends with "/" (for example "langgraph/"): ' +
        'it scopes both the offloaded objects and the S3 lifecycle rule',
      's3.keyPrefix',
    );
  }
}

/**
 * Build a deterministic, TTL-independent lifecycle rule id from the prefix.
 * Trailing slashes are trimmed with a loop rather than `/\/+$/`, whose
 * backtracking is quadratic in the number of slashes.
 */
export function buildLifecycleRuleId(prefix: string): string {
  let trimmed = prefix;
  while (trimmed.endsWith('/')) trimmed = trimmed.slice(0, -1);
  const slug = trimmed.replace(/[^a-zA-Z0-9-]/g, '-') || 'default';
  return `langgraph-ttl-${slug}`;
}

/** An adapter's default S3 key prefix: the shared base plus its own segment. */
export function defaultAdapterKeyPrefix(base: string, adapter: string): string {
  return `${base}${adapter}/`;
}
