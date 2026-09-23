import { allKeysOf } from '../../shared/validation/option-shape';
import type { DynamoDBStoreOptions, ListNamespacesOptions, SearchOptions } from '../types';

/**
 * The keys of each store option bag, exhaustive in both directions:
 * `allKeysOf<T>` makes omitting or inventing one a compile error, so a list
 * cannot rot away from the type it guards. They live with the feature because
 * the types they are checked against do; `shared/` knows no feature.
 */
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

/** See {@link STORE_KEYS}. */
export const STORE_SEARCH_KEYS = allKeysOf<SearchOptions>({
  filter: 'filter',
  limit: 'limit',
  offset: 'offset',
  query: 'query',
  signal: 'signal',
});

/**
 * See {@link STORE_KEYS}. `ListNamespacesOptions` is pinned equal to
 * `BaseStore.listNamespaces`' own parameter type, so this list is checked
 * against upstream's options through it.
 */
export const STORE_LIST_NAMESPACES_KEYS = allKeysOf<ListNamespacesOptions>({
  prefix: 'prefix',
  suffix: 'suffix',
  maxDepth: 'maxDepth',
  limit: 'limit',
  offset: 'offset',
});
