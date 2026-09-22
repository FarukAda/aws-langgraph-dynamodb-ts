import type { DynamoDBSaverOptions } from '../../checkpointer/types';
import type { DynamoDBChatMessageHistoryOptions } from '../../history/types';
import type { DynamoDBStoreOptions } from '../../store/types';
import { allKeysOf } from './option-shape';

/**
 * The keys of each adapter's option bag, exhaustive in both directions.
 *
 * These live apart from `options.ts` because that file is near the 150-line
 * cap, and because a drifted list is what decides that a key is *unknown* —
 * `allKeysOf<T>` makes omitting or inventing one a compile error, so the lists
 * cannot rot away from the types they guard.
 */
export const SAVER_KEYS = allKeysOf<DynamoDBSaverOptions>({
  tableName: 'tableName',
  client: 'client',
  clientConfig: 'clientConfig',
  createClient: 'createClient',
  ttl: 'ttl',
  logger: 'logger',
  retry: 'retry',
  indexShards: 'indexShards',
  indexName: 'indexName',
  readConcurrency: 'readConcurrency',
  compression: 'compression',
  s3: 's3',
  serde: 'serde',
});

/** See {@link SAVER_KEYS}. */
export const STORE_KEYS = allKeysOf<DynamoDBStoreOptions>({
  tableName: 'tableName',
  client: 'client',
  clientConfig: 'clientConfig',
  createClient: 'createClient',
  ttl: 'ttl',
  logger: 'logger',
  retry: 'retry',
  indexShards: 'indexShards',
  indexName: 'indexName',
  readConcurrency: 'readConcurrency',
  compression: 'compression',
  s3: 's3',
  serde: 'serde',
  index: 'index',
  vectorBackend: 'vectorBackend',
  maxSearchCandidates: 'maxSearchCandidates',
  maxScanItems: 'maxScanItems',
  vectorScoreDirection: 'vectorScoreDirection',
});

/** See {@link SAVER_KEYS}. */
export const HISTORY_KEYS = allKeysOf<DynamoDBChatMessageHistoryOptions>({
  tableName: 'tableName',
  client: 'client',
  clientConfig: 'clientConfig',
  createClient: 'createClient',
  ttl: 'ttl',
  logger: 'logger',
  retry: 'retry',
  indexShards: 'indexShards',
  indexName: 'indexName',
  readConcurrency: 'readConcurrency',
  compression: 'compression',
  s3: 's3',
  serde: 'serde',
  onCorruptMessage: 'onCorruptMessage',
});
