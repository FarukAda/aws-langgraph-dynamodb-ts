import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import type { CompressionConfig } from '../../shared/codec/compression';
import { defaultAdapterKeyPrefix } from '../../shared/codec/s3/config';
import { S3Offloader } from '../../shared/codec/s3/offloader';
import { DEFAULT_S3_KEY_PREFIX } from '../../shared/constants';
import { resolveDynamoDBClient } from '../../shared/dynamodb/client';
import { type Logger, resolveLogger } from '../../shared/logging/logger';
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
  const resolved = resolveDynamoDBClient(options);
  const offloader = options.s3
    ? new S3Offloader({
        ...options.s3,
        keyPrefix:
          options.s3.keyPrefix ?? defaultAdapterKeyPrefix(DEFAULT_S3_KEY_PREFIX, 'checkpointer'),
      })
    : undefined;
  return {
    context: {
      client: resolved.client,
      tableName: options.tableName,
      serde,
      compression: options.compression,
      offloader,
      ttl: options.ttl,
      logger: resolveLogger(options.logger),
    },
    ddbClient: resolved.ddbClient,
    ownsClient: resolved.ownsClient,
  };
}
