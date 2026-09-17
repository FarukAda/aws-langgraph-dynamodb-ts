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
  /**
   * @internal Test seam and dependency-injection hook for constructing the
   * underlying DynamoDB client; not part of the supported surface and absent from the
   * shipped declarations.
   */
  createClient?: (config: DynamoDBClientConfig) => DynamoDBClient;
  /** Optional time-to-live applied to written items. */
  ttl?: TtlOption;
  /** Optional per-instance logger (defaults to a silent logger). */
  logger?: Logger;
  /** Retry budget and backoff for every DynamoDB call (see the README "Retries and backoff"). */
  retry?: RetryPolicy;
  /**
   * Index partitions per adapter in the recency index (GSI1), default 8.
   *
   * Rows carry the index attributes whether or not the table defines the
   * index, so enabling it later needs no rewrite of new rows — only a backfill
   * of the old ones. The value is fixed at table creation: changing it changes
   * every row's shard, so an existing index must be backfilled again.
   *
   * A single index partition per adapter would concentrate every listing on
   * one partition, which is worse than the table scan it replaces.
   */
  indexShards?: number;
  /**
   * Name of the recency index (a GSI on `gsi1pk`/`gsi1sk`) on this table.
   *
   * Opt-in on purpose: whether the table carries the index is deployment
   * configuration the operator knows, and probing for it would spend a failed
   * request per process to find out. Naming it switches two listings that
   * would otherwise scan the whole table onto a read of the index, newest
   * first: `history.listSessions`, which pages it by cursor, and a
   * `saver.list` without a `thread_id`, which streams it and takes no cursor.
   * Leaving it unset keeps both on the table scan, so the index can be created
   * and backfilled before any adapter reads it.
   */
  indexName?: string;
  /**
   * How many payloads a single call decodes at once, default 8.
   *
   * It is the multiplier on this package's memory ceiling, which is
   * `readConcurrency × (s3.maxDownloadBytes + compression.maxDecompressedBytes)`
   * — a downloaded object and its decompressed form are both resident while a
   * payload is decoded, and that much can be in flight for each concurrent
   * decode. Lower it on a small container; raising it trades memory for
   * latency on reads that fetch many offloaded payloads.
   *
   * It also bounds how many recency-index shards one listing queries at once.
   */
  readConcurrency?: number;
}

/** Options enabling payload compression and/or S3 offloading. */
export interface CodecOptions {
  /** Gzip compression configuration. */
  compression?: CompressionConfig;
  /** S3 offload configuration for payloads over DynamoDB's item limit. */
  s3?: S3OffloadConfig;
}

/** Per-call cancellation for the long-running adapter methods. */
export interface CancelOptions {
  /** Aborting it rejects the call with `AbortError` (`ABORTED`) at the next wait. */
  signal?: AbortSignal;
}
