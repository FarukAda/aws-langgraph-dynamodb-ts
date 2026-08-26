import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';

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
 */
export function buildS3Key(prefix: string, parts: readonly string[]): string {
  const encoded = parts.map((part) => Buffer.from(part, 'utf8').toString('base64url'));
  return `${prefix}${encoded.join('/')}.bin`;
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
