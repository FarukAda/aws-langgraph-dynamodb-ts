import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';

import { MAX_S3_KEY_BYTES } from '../../constants';
import { ValidationError } from '../../errors/errors';

/** Configuration for offloading large payloads to S3. */
export interface S3OffloadConfig {
  bucketName: string;
  keyPrefix?: string;
  thresholdBytes?: number;
  serverSideEncryption?: string;
  sseKmsKeyId?: string;
  clientConfig?: S3ClientConfig;
  createS3Client?: (config: S3ClientConfig) => S3Client;
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
  const encoded = parts.map((part) => Buffer.from(part, 'utf8').toString('base64url'));
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

/** Build a deterministic, TTL-independent lifecycle rule id from the prefix. */
export function buildLifecycleRuleId(prefix: string): string {
  const slug = prefix.replace(/\/+$/, '').replace(/[^a-zA-Z0-9-]/g, '-') || 'default';
  return `langgraph-ttl-${slug}`;
}

/** An adapter's default S3 key prefix: the shared base plus its own segment. */
export function defaultAdapterKeyPrefix(base: string, adapter: string): string {
  return `${base}${adapter}/`;
}
