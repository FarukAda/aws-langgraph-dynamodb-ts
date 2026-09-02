import type { DynamoDBClient, DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import type { CompressionConfig } from './codec/compression';
import type { S3OffloadConfig } from './codec/s3/config';
import type { RetryPolicy } from './dynamodb/retry-policy';
import type { Logger } from './logging/logger';
import type { TtlOption } from './validation/ttl';

/**
 * Options common to every adapter (the unified options shape). An adapter
 * either reuses an injected `client` or builds one from `clientConfig`.
 */
export interface BaseAdapterOptions {
  /** DynamoDB table name. */
  tableName: string;
  /** Pre-built DocumentClient to reuse; when set, the adapter does not own it. */
  client?: DynamoDBDocument;
  /** Config used to build a client when `client` is not provided. */
  clientConfig?: DynamoDBClientConfig;
  /** Factory seam for constructing the underlying client (testing). */
  createClient?: (config: DynamoDBClientConfig) => DynamoDBClient;
  /** Optional time-to-live applied to written items. */
  ttl?: TtlOption;
  /** Optional per-instance logger (defaults to a silent logger). */
  logger?: Logger;
  /** Retry budget and backoff for every DynamoDB call (see the README "Retries and backoff"). */
  retry?: RetryPolicy;
}

/** Options enabling payload compression and/or S3 offloading. */
export interface CodecOptions {
  /** Gzip compression configuration. */
  compression?: CompressionConfig;
  /** S3 offload configuration for payloads over DynamoDB's item limit. */
  s3?: S3OffloadConfig;
}
