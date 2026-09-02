import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { IndexConfig, SerializerProtocol } from '@langchain/langgraph-checkpoint';

import type { CompressionConfig } from '../../shared/codec/compression';
import { JSON_SERDE } from '../../shared/codec/json-serde';
import { offloaderConfigFor } from '../../shared/codec/s3/adapter-config';
import { S3Offloader } from '../../shared/codec/s3/offloader';
import { DEFAULT_MAX_SEARCH_CANDIDATES, MAX_TOTAL_ITEMS_IN_MEMORY } from '../../shared/constants';
import { resolveDynamoDBClient } from '../../shared/dynamodb/client';
import { type Logger, resolveLogger } from '../../shared/logging/logger';
import type { TtlOption } from '../../shared/validation/ttl';
import type { DynamoDBStoreOptions } from '../types';
import type { VectorBackend } from '../vector-backend';
import { validateStoreOptions } from './option-validation';
import type { VectorScoreDirection } from './score-direction';

/** Resolved collaborators shared by every store action. */
export interface StoreContext {
  client: DynamoDBDocument;
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
}

/** Result of wiring up a store from its options. */
export interface StoreSetup {
  context: StoreContext;
  ddbClient: DynamoDBClient | undefined;
  ownsClient: boolean;
}

/** Validate the options, then resolve the client, offloader, serializer, and index. */
export function setUpStore(options: DynamoDBStoreOptions): StoreSetup {
  validateStoreOptions(options);
  const resolved = resolveDynamoDBClient(options);
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
      logger: resolveLogger(options.logger),
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
