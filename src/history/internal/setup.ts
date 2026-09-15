import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import type { CompressionConfig } from '../../shared/codec/compression';
import { JSON_SERDE } from '../../shared/codec/json-serde';
import { offloaderConfigFor } from '../../shared/codec/s3/adapter-config';
import { S3Offloader } from '../../shared/codec/s3/offloader';
import { DEFAULT_READ_CONCURRENCY } from '../../shared/constants';
import { resolveDynamoDBClient, warnOnStackedRetries } from '../../shared/dynamodb/client';
import { DEFAULT_INDEX_SHARDS } from '../../shared/dynamodb/index-keys';
import type { RetryOptions } from '../../shared/dynamodb/retry';
import { resolveRetryPolicy } from '../../shared/dynamodb/retry-policy';
import { ValidationError } from '../../shared/errors/errors';
import { type Logger, resolveLogger } from '../../shared/logging/logger';
import { createUlidFactory } from '../../shared/ulid';
import { HISTORY_KEYS } from '../../shared/validation/adapter-keys';
import { assertShape } from '../../shared/validation/option-shape';
import { validateBaseAdapterOptions } from '../../shared/validation/options';
import type { TtlOption } from '../../shared/validation/ttl';
import type { CorruptMessagePolicy, DynamoDBChatMessageHistoryOptions } from '../types';

const CORRUPT_MESSAGE_POLICIES: readonly CorruptMessagePolicy[] = ['skip', 'throw'];

/** Resolved collaborators shared by every chat-history action. */
export interface HistoryContext {
  client: DynamoDBDocument;
  tableName: string;
  serde: SerializerProtocol;
  compression?: CompressionConfig;
  offloader?: S3Offloader;
  ttl?: TtlOption;
  logger: Logger;
  ulid: () => string;
  onCorruptMessage: CorruptMessagePolicy;
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

/** Result of wiring up a chat-history adapter from its options. */
export interface HistorySetup {
  context: HistoryContext;
  ddbClient: DynamoDBClient | undefined;
  ownsClient: boolean;
}

/**
 * Validate the options, then resolve the client, offloader and serializer.
 *
 * Accepts: `options` — validated first, so no half-built adapter exists when
 * one is wrong. `onCorruptMessage` is checked against its union here because a
 * JavaScript caller can pass a string the type never admits, and an
 * unrecognised policy would silently behave as `'skip'` — dropping messages a
 * caller asked to be told about.
 *
 * Returns: the context every action shares, plus the client and whether this
 * adapter owns it — a client the caller passed in is never destroyed by
 * `destroy()`.
 *
 * Throws: ValidationError naming the offending option.
 *
 * Guarantees: constructing an adapter performs no I/O.
 */
export function setUpHistory(options: DynamoDBChatMessageHistoryOptions): HistorySetup {
  assertShape(options, HISTORY_KEYS, 'options');
  validateBaseAdapterOptions(options);
  if (
    options.onCorruptMessage !== undefined &&
    !CORRUPT_MESSAGE_POLICIES.includes(options.onCorruptMessage)
  ) {
    throw new ValidationError(
      `onCorruptMessage must be one of ${CORRUPT_MESSAGE_POLICIES.join(' | ')}`,
      'onCorruptMessage',
    );
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
        ? new S3Offloader(offloaderConfigFor(options.s3, 'history', options.clientConfig))
        : undefined,
      ttl: options.ttl,
      logger,
      retry: resolveRetryPolicy(options.retry, logger),
      indexShards: options.indexShards ?? DEFAULT_INDEX_SHARDS,
      readConcurrency: options.readConcurrency ?? DEFAULT_READ_CONCURRENCY,
      indexName: options.indexName,
      ulid: createUlidFactory(),
      onCorruptMessage: options.onCorruptMessage ?? 'skip',
    },
    ddbClient: resolved.ddbClient,
    ownsClient: resolved.ownsClient,
  };
}
