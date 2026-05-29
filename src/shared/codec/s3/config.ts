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

/** Build a fully-qualified S3 key: `${prefix}${parts.join('/')}.bin`. */
export function buildS3Key(prefix: string, parts: readonly string[]): string {
  return `${prefix}${parts.join('/')}.bin`;
}

/** Build a deterministic, TTL-independent lifecycle rule id from the prefix. */
export function buildLifecycleRuleId(prefix: string): string {
  const slug = prefix.replace(/\/+$/, '').replace(/[^a-zA-Z0-9-]/g, '-') || 'default';
  return `langgraph-ttl-${slug}`;
}