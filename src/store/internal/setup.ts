import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { IndexConfig, SerializerProtocol } from '@langchain/langgraph-checkpoint';

import type { CompressionConfig } from '../../shared/codec/compression';
import { JSON_SERDE } from '../../shared/codec/json-serde';
import { offloaderConfigFor } from '../../shared/codec/s3/adapter-config';
import { S3Offloader } from '../../shared/codec/s3/offloader';
import {
  DEFAULT_MAX_SEARCH_CANDIDATES,
  DEFAULT_READ_CONCURRENCY,
  MAX_TOTAL_ITEMS_IN_MEMORY,
} from '../../shared/constants';
import { resolveDynamoDBClient, warnOnStackedRetries } from '../../shared/dynamodb/client';
import type { DynamoDBDocumentLike } from '../../shared/dynamodb/client-types';
import { DEFAULT_INDEX_SHARDS } from '../../shared/dynamodb/index-keys';
import type { RetryOptions } from '../../shared/dynamodb/retry';
import { resolveRetryPolicy } from '../../shared/dynamodb/retry-policy';
import { type Logger, resolveLogger } from '../../shared/logging/logger';
import {
  assertBaseCollaborators,
  assertMembers,
  VECTOR_BACKEND_MEMBERS,
} from '../../shared/validation/collaborators';
import { assertShape } from '../../shared/validation/option-shape';
import type { TtlOption } from '../../shared/validation/ttl';
import type { DynamoDBStoreOptions } from '../types';
import type { VectorBackend, VectorScoreDirection } from '../vector-backend';
import { STORE_KEYS } from './option-keys';
import { assertStoreOptions } from './option-validation';

/** Resolved collaborators shared by every store action. */
export interface StoreContext {
  client: DynamoDBDocumentLike;
  tableName: string;
  serde: SerializerProtocol;
  compression?: CompressionConfig;
  offloader?: S3Offloader;
  ttl?: TtlOption;
  logger: Logger;
  index?: IndexConfig;
  vectorBackend?: VectorBackend;
  vectorScoreDirection: VectorScoreDirection;
  maxSearchCandidates: number;
  maxScanItems: number;
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

/** Result of wiring up a store from its options. */
export interface StoreSetup {
  context: StoreContext;
  ddbClient: DynamoDBClient | undefined;
  ownsClient: boolean;
}

/**
 * Validate the options, then resolve the client, offloader, serializer and index.
 *
 * Accepts: `options` — validated first, so no half-built store exists when one
 * is wrong. Everything optional has a default here and nowhere else, which is
 * what lets every action read `context.x` without re-deciding what absent means.
 *
 * Returns: the context every action shares, plus the client and whether this
 * store owns it — a client the caller passed in is never destroyed by
 * `destroy()`.
 *
 * Throws: `VALIDATION` for any invalid option, naming the option.
 *
 * Guarantees: constructing a store performs no I/O. The stacked-retry check is
 * deliberately not awaited: it is a warning about a caller-supplied client, not
 * a precondition.
 */
export function setUpStore(options: DynamoDBStoreOptions): StoreSetup {
  assertShape(options, STORE_KEYS, 'options');
  assertStoreOptions(options);
  assertBaseCollaborators(options);
  if (options.vectorBackend !== undefined) {
    assertMembers(options.vectorBackend, VECTOR_BACKEND_MEMBERS, 'vectorBackend');
  }
  const logger = resolveLogger(options.logger);
  const resolved = resolveDynamoDBClient(options);
  if (!resolved.ownsClient) void warnOnStackedRetries(resolved.client, logger);
  return {
    context: {
      client: resolved.client,
      tableName: options.tableName,
      serde: options.serde ?? JSON_SERDE,
      compression: options.compression,
      offloader: options.s3
        ? new S3Offloader(offloaderConfigFor(options.s3, 'store', options.clientConfig))
        : undefined,
      ttl: options.ttl,
      logger,
      retry: resolveRetryPolicy(options.retry, logger),
      indexShards: options.indexShards ?? DEFAULT_INDEX_SHARDS,
      readConcurrency: options.readConcurrency ?? DEFAULT_READ_CONCURRENCY,
      indexName: options.indexName,
      index: options.index,
      vectorBackend: options.vectorBackend,
      vectorScoreDirection: options.vectorScoreDirection ?? 'relevance',
      maxSearchCandidates: options.maxSearchCandidates ?? DEFAULT_MAX_SEARCH_CANDIDATES,
      maxScanItems: options.maxScanItems ?? MAX_TOTAL_ITEMS_IN_MEMORY,
    },
    ddbClient: resolved.ddbClient,
    ownsClient: resolved.ownsClient,
  };
}
