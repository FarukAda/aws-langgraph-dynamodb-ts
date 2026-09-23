import type { CheckpointListOptions } from '@langchain/langgraph-checkpoint';

import { allKeysOf } from '../../shared/validation/option-shape';
import type { DeltaChannelHistoryOptions, DynamoDBSaverOptions } from '../types';

/**
 * The keys of each checkpointer option bag, exhaustive in both directions:
 * `allKeysOf<T>` makes omitting or inventing one a compile error, so a list
 * cannot rot away from the type it guards. They live with the feature because
 * the types they are checked against do; `shared/` knows no feature.
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
export const SAVER_LIST_KEYS = allKeysOf<CheckpointListOptions>({
  limit: 'limit',
  before: 'before',
  filter: 'filter',
});

/**
 * See {@link SAVER_KEYS}. `DeltaChannelHistoryOptions` is pinned equal to
 * `BaseCheckpointSaver.getDeltaChannelHistory`'s own parameter type, the
 * contract that method implements, so this list is checked against it.
 */
export const DELTA_CHANNEL_HISTORY_KEYS = allKeysOf<DeltaChannelHistoryOptions>({
  config: 'config',
  channels: 'channels',
});
