import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import type { CompressionConfig } from '../../shared/codec/compression';
import { JSON_SERDE } from '../../shared/codec/json-serde';
import { offloaderConfigFor } from '../../shared/codec/s3/adapter-config';
import { S3Offloader } from '../../shared/codec/s3/offloader';
import { resolveDynamoDBClient } from '../../shared/dynamodb/client';
import { ValidationError } from '../../shared/errors/errors';
import { type Logger, resolveLogger } from '../../shared/logging/logger';
import { createUlidFactory } from '../../shared/ulid';
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
}

/** Result of wiring up a chat-history adapter from its options. */
export interface HistorySetup {
  context: HistoryContext;
  ddbClient: DynamoDBClient | undefined;
  ownsClient: boolean;
}

/** Resolve the client, optional S3 offloader, and serializer into a context. */
export function setUpHistory(options: DynamoDBChatMessageHistoryOptions): HistorySetup {
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
  const resolved = resolveDynamoDBClient(options);
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
      logger: resolveLogger(options.logger),
      ulid: createUlidFactory(),
      onCorruptMessage: options.onCorruptMessage ?? 'skip',
    },
    ddbClient: resolved.ddbClient,
    ownsClient: resolved.ownsClient,
  };
}
