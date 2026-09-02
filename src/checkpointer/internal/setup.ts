import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import type { CompressionConfig } from '../../shared/codec/compression';
import { offloaderConfigFor } from '../../shared/codec/s3/adapter-config';
import { S3Offloader } from '../../shared/codec/s3/offloader';
import { resolveDynamoDBClient, warnOnStackedRetries } from '../../shared/dynamodb/client';
import type { RetryOptions } from '../../shared/dynamodb/retry';
import { resolveRetryPolicy } from '../../shared/dynamodb/retry-policy';
import { type Logger, resolveLogger } from '../../shared/logging/logger';
import { validateBaseAdapterOptions } from '../../shared/validation/options';
import type { TtlOption } from '../../shared/validation/ttl';
import type { DynamoDBSaverOptions } from '../types';

/** Resolved collaborators shared by every checkpointer action. */
export interface CheckpointerContext {
  client: DynamoDBDocument;
  tableName: string;
  serde: SerializerProtocol;
  compression?: CompressionConfig;
  offloader?: S3Offloader;
  ttl?: TtlOption;
  logger: Logger;
  /** Retry budget and backoff for every DynamoDB call, with the retry debug log attached. */
  retry?: RetryOptions;
}

/** Result of wiring up a checkpointer from its options. */
export interface CheckpointerSetup {
  context: CheckpointerContext;
  ddbClient: DynamoDBClient | undefined;
  ownsClient: boolean;
}

/**
 * Resolve the DynamoDB client, optional S3 offloader, and logging into the
 * context every action receives, plus the ownership info the class needs to
 * tear resources down.
 */
export function setUpCheckpointer(
  options: DynamoDBSaverOptions,
  serde: SerializerProtocol,
): CheckpointerSetup {
  validateBaseAdapterOptions(options);
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
    },
    ddbClient: resolved.ddbClient,
    ownsClient: resolved.ownsClient,
  };
}
