import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import type { CompressionConfig } from '../../shared/codec/compression';
import { offloaderConfigFor } from '../../shared/codec/s3/adapter-config';
import { S3Offloader } from '../../shared/codec/s3/offloader';
import { DEFAULT_READ_CONCURRENCY } from '../../shared/constants';
import { resolveDynamoDBClient, warnOnStackedRetries } from '../../shared/dynamodb/client';
import type { DynamoDBDocumentLike } from '../../shared/dynamodb/client-types';
import { DEFAULT_INDEX_SHARDS } from '../../shared/dynamodb/index-keys';
import type { RetryOptions } from '../../shared/dynamodb/retry';
import { resolveRetryPolicy } from '../../shared/dynamodb/retry-policy';
import { type Logger, resolveLogger } from '../../shared/logging/logger';
import { assertBaseCollaborators } from '../../shared/validation/collaborators';
import { assertShape } from '../../shared/validation/option-shape';
import { assertBaseAdapterOptions } from '../../shared/validation/options';
import type { TtlOption } from '../../shared/validation/ttl';
import type { DynamoDBSaverOptions } from '../types';
import { SAVER_KEYS } from './option-keys';

/** Resolved collaborators shared by every checkpointer action. */
export interface CheckpointerContext {
  client: DynamoDBDocumentLike;
  tableName: string;
  serde: SerializerProtocol;
  compression?: CompressionConfig;
  offloader?: S3Offloader;
  ttl?: TtlOption;
  logger: Logger;
  /** Retry budget and backoff for every DynamoDB call, with the retry debug log attached. */
  retry?: RetryOptions;
  /**
   * Index partitions per adapter for the recency index; see `indexKeys`.
   * Absent means the default, which is where it is resolved.
   */
  indexShards?: number;
  /** Payloads decoded at once by one call; the memory ceiling’s multiplier. */
  readConcurrency?: number;
  /** Name of the recency index, when the table carries one; see `BaseAdapterOptions.indexName`. */
  indexName?: string;
}

/** Result of wiring up a checkpointer from its options. */
export interface CheckpointerSetup {
  context: CheckpointerContext;
  ddbClient: DynamoDBClient | undefined;
  ownsClient: boolean;
}

/**
 * Validate the options, then resolve the client, offloader and serializer.
 *
 * Accepts: `options` — validated first, so no half-built saver exists when one
 * is wrong. `serde` — the base class's, which is the caller's own serializer
 * when they gave one.
 *
 * Returns: the context every action receives, plus the client and whether this
 * saver owns it — a client the caller passed in is never destroyed by
 * `destroy()`.
 *
 * Throws: `VALIDATION` naming the offending option.
 *
 * Guarantees: constructing a saver performs no I/O.
 */
export function setUpCheckpointer(
  options: DynamoDBSaverOptions,
  serde: SerializerProtocol,
): CheckpointerSetup {
  assertShape(options, SAVER_KEYS, 'options');
  assertBaseAdapterOptions(options);
  assertBaseCollaborators(options);
  const logger = resolveLogger(options.logger);
  const resolved = resolveDynamoDBClient(options);
  if (!resolved.ownsClient) void warnOnStackedRetries(resolved.client, logger);
  const offloader = options.s3
    ? new S3Offloader(offloaderConfigFor(options.s3, 'checkpointer', options.clientConfig))
    : undefined;
  return {
    context: {
      client: resolved.client,
      tableName: options.tableName,
      serde,
      compression: options.compression,
      offloader,
      ttl: options.ttl,
      logger,
      retry: resolveRetryPolicy(options.retry, logger),
      indexShards: options.indexShards ?? DEFAULT_INDEX_SHARDS,
      readConcurrency: options.readConcurrency ?? DEFAULT_READ_CONCURRENCY,
      indexName: options.indexName,
    },
    ddbClient: resolved.ddbClient,
    ownsClient: resolved.ownsClient,
  };
}
