import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import type { CompressionConfig } from '../../shared/codec/compression';
import { JSON_SERDE } from '../../shared/codec/json-serde';
import { defaultAdapterKeyPrefix } from '../../shared/codec/s3/config';
import { S3Offloader } from '../../shared/codec/s3/offloader';
import { DEFAULT_S3_KEY_PREFIX } from '../../shared/constants';
import { resolveDynamoDBClient } from '../../shared/dynamodb/client';
import { type Logger, resolveLogger } from '../../shared/logging/logger';
import { createUlidFactory } from '../../shared/ulid';
import type { TtlOption } from '../../shared/validation/ttl';
import type { DynamoDBChatMessageHistoryOptions } from '../types';

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
}

/** Result of wiring up a chat-history adapter from its options. */
export interface HistorySetup {
  context: HistoryContext;
  ddbClient: DynamoDBClient | undefined;
  ownsClient: boolean;
}

/** Resolve the client, optional S3 offloader, and serializer into a context. */
export function setUpHistory(options: DynamoDBChatMessageHistoryOptions): HistorySetup {
  const resolved = resolveDynamoDBClient(options);
  return {
    context: {
      client: resolved.client,
      tableName: options.tableName,
      serde: options.serde ?? JSON_SERDE,
      compression: options.compression,
      offloader: options.s3
        ? new S3Offloader({
            ...options.s3,
            keyPrefix:
              options.s3.keyPrefix ?? defaultAdapterKeyPrefix(DEFAULT_S3_KEY_PREFIX, 'history'),
          })
        : undefined,
      ttl: options.ttl,
      logger: resolveLogger(options.logger),
      ulid: createUlidFactory(),
    },
    ddbClient: resolved.ddbClient,
    ownsClient: resolved.ownsClient,
  };
}
