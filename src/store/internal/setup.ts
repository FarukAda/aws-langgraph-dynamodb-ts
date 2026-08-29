import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { Embeddings } from '@langchain/core/embeddings';
import type { IndexConfig, SerializerProtocol } from '@langchain/langgraph-checkpoint';

import type { CompressionConfig } from '../../shared/codec/compression';
import { JSON_SERDE } from '../../shared/codec/json-serde';
import { defaultAdapterKeyPrefix } from '../../shared/codec/s3/config';
import { S3Offloader } from '../../shared/codec/s3/offloader';
import {
  DEFAULT_MAX_SEARCH_CANDIDATES,
  DEFAULT_S3_KEY_PREFIX,
  MAX_TOTAL_ITEMS_IN_MEMORY,
} from '../../shared/constants';
import { resolveDynamoDBClient } from '../../shared/dynamodb/client';
import { ValidationError } from '../../shared/errors/errors';
import { type Logger, resolveLogger } from '../../shared/logging/logger';
import type { TtlOption } from '../../shared/validation/ttl';
import type { DynamoDBStoreOptions } from '../types';
import type { VectorBackend } from '../vector-backend';

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
  maxSearchCandidates: number;
  maxScanItems: number;
}

/** Result of wiring up a store from its options. */
export interface StoreSetup {
  context: StoreContext;
  ddbClient: DynamoDBClient | undefined;
  ownsClient: boolean;
}

/**
 * Reject an `index` that cannot actually embed. `IndexConfig` mandates
 * `embeddings`, but a JavaScript caller can omit it or pass the wrong shape,
 * and the failure then surfaced as a raw `TypeError` deep inside the first
 * `put()`/`search()` rather than this library's typed error at construction.
 *
 * Only `embeddings` is checked. `dims` is part of the upstream type but is
 * never read anywhere in this package, so rejecting a configuration over it
 * would break working callers for no benefit.
 */
function assertUsableIndex(index?: IndexConfig): void {
  if (!index) return;
  const embeddings: Partial<Embeddings> | undefined = index.embeddings;
  if (typeof embeddings?.embedQuery !== 'function') {
    throw new ValidationError(
      '`index.embeddings` must be an Embeddings implementation exposing embedQuery(); ' +
        'without one no embedding can be computed for put() or search()',
      'index',
    );
  }
}

/**
 * Resolve the client, optional S3 offloader, serializer, and index config.
 *
 * A `vectorBackend` without an `index` is rejected outright rather than
 * silently degrading: with no embeddings configured, every `put` would compute
 * no vector and instruct the backend to *delete* the item's entry instead of
 * indexing it, and `search()` would fall through to an unranked scan-order
 * listing with no `.score` field and no error — a semantic query returning a
 * normal-looking but meaningless response. `reconcileVectorIndex` already
 * refused this exact misconfiguration.
 */
export function setUpStore(options: DynamoDBStoreOptions): StoreSetup {
  if (options.vectorBackend && !options.index) {
    throw new ValidationError(
      'vectorBackend requires a configured `index` (embeddings); without one no embedding ' +
        'is computed, every put would clear the item vector, and search would silently return ' +
        'unranked, score-less results',
      'vectorBackend',
    );
  }
  assertUsableIndex(options.index);
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
              options.s3.keyPrefix ?? defaultAdapterKeyPrefix(DEFAULT_S3_KEY_PREFIX, 'store'),
          })
        : undefined,
      ttl: options.ttl,
      logger: resolveLogger(options.logger),
      index: options.index,
      vectorBackend: options.vectorBackend,
      maxSearchCandidates: options.maxSearchCandidates ?? DEFAULT_MAX_SEARCH_CANDIDATES,
      maxScanItems: options.maxScanItems ?? MAX_TOTAL_ITEMS_IN_MEMORY,
    },
    ddbClient: resolved.ddbClient,
    ownsClient: resolved.ownsClient,
  };
}
