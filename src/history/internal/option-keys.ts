import { allKeysOf } from '../../shared/validation/option-shape';
import type {
  DynamoDBChatMessageHistoryOptions,
  GetMessagesOptions,
  ListSessionsOptions,
} from '../types';

/**
 * The keys of each chat-history option bag, exhaustive in both directions:
 * `allKeysOf<T>` makes omitting or inventing one a compile error, so a list
 * cannot rot away from the type it guards. They live with the feature because
 * the types they are checked against do; `shared/` knows no feature.
 */
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

/** See {@link HISTORY_KEYS}. */
export const GET_MESSAGES_KEYS = allKeysOf<GetMessagesOptions>({
  limit: 'limit',
  before: 'before',
  signal: 'signal',
});

/** See {@link HISTORY_KEYS}. */
export const LIST_SESSIONS_KEYS = allKeysOf<ListSessionsOptions>({
  limit: 'limit',
  cursor: 'cursor',
  maxIterations: 'maxIterations',
  maxItems: 'maxItems',
  signal: 'signal',
});
