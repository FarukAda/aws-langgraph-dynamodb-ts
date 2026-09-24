/**
 * Hides which options the store and its methods accept, and how the store is
 * assembled from them.
 *
 * The exhaustive key list of every option bag — the constructor's, `search`'s,
 * `listNamespaces`' — lives here, compiler-checked against its type. The
 * store's own options are checked after the shared ones — the in-memory caps,
 * that a vector backend comes with an index, that the index can embed, the
 * score direction — and the context every operation receives is built with its
 * defaults filled in.
 */

import type { IndexConfig, SerializerProtocol } from '@langchain/langgraph-checkpoint';

import { type AdapterCore, type AdapterShell, openAdapter } from '../../shared/adapter';
import { JSON_SERDE } from '../../shared/codec/json-serde';
import {
  DEFAULT_MAX_SEARCH_CANDIDATES,
  MAX_SCAN_ITEMS,
  MAX_SEARCH_CANDIDATES,
  MAX_TOTAL_ITEMS_IN_MEMORY,
} from '../../shared/constants';
import { validationError } from '../../shared/errors/errors';
import {
  assertMembers,
  EMBEDDINGS_MEMBERS,
  VECTOR_BACKEND_MEMBERS,
} from '../../shared/validation/collaborators';
import { allKeysOf, assertShape } from '../../shared/validation/option-shape';
import { assertInteger, assertStringArray } from '../../shared/validation/primitives';
import type { DynamoDBStoreOptions, ListNamespacesOptions, SearchOptions } from '../types';
import {
  VECTOR_SCORE_DIRECTIONS,
  type VectorBackend,
  type VectorScoreDirection,
} from '../vector-backend';

/** Resolved collaborators shared by every store action. */
export interface StoreContext extends AdapterCore {
  serde: SerializerProtocol;
  index?: IndexConfig;
  vectorBackend?: VectorBackend;
  vectorScoreDirection: VectorScoreDirection;
  maxSearchCandidates: number;
  maxScanItems: number;
}

/** Result of wiring up a store from its options. */
export interface StoreSetup {
  context: StoreContext;
  shell: AdapterShell;
}

/**
 * Validate the options, then resolve the client, offloader, serializer and index.
 *
 * Accepts: `options` — validated first, so no half-built store exists when one
 * is wrong. Everything optional has a default here and nowhere else, which is
 * what lets every action read `context.x` without re-deciding what absent means.
 *
 * Returns: the context every action shares, and the shell that releases what
 * it holds — a client the caller passed in is never destroyed by `destroy()`.
 *
 * Throws: `VALIDATION` for any invalid option, naming the option.
 *
 * Guarantees: constructing a store performs no I/O. The stacked-retry check is
 * deliberately not awaited: it is a warning about a caller-supplied client, not
 * a precondition.
 */
export function setUpStore(options: DynamoDBStoreOptions): StoreSetup {
  assertShape(options, STORE_KEYS, 'options');
  const shell = openAdapter(options, 'store', {
    options: () => assertStoreOptions(options),
    collaborators: () => {
      if (options.vectorBackend !== undefined) {
        assertMembers(options.vectorBackend, VECTOR_BACKEND_MEMBERS, 'vectorBackend');
      }
    },
  });
  return {
    shell,
    context: {
      ...shell.core,
      serde: options.serde ?? JSON_SERDE,
      index: options.index,
      vectorBackend: options.vectorBackend,
      vectorScoreDirection: options.vectorScoreDirection ?? 'relevance',
      maxSearchCandidates: options.maxSearchCandidates ?? DEFAULT_MAX_SEARCH_CANDIDATES,
      maxScanItems: options.maxScanItems ?? MAX_TOTAL_ITEMS_IN_MEMORY,
    },
  };
}

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

/**
 * The keys `IndexConfig` declares. The type is upstream's, but this package is
 * what reads `index`, so a key missing from this list — a misspelling, or one
 * a later upstream release adds — is one it would silently ignore; refusing it
 * is what tells the caller their setting is not in effect.
 */
const INDEX_KEYS = allKeysOf<IndexConfig>({
  dims: 'dims',
  embeddings: 'embeddings',
  fields: 'fields',
});

/**
 * Reject an `index` that cannot actually embed. `IndexConfig` mandates
 * `embeddings`, but a JavaScript caller can omit it or pass the wrong shape,
 * and the failure then surfaced as a raw `TypeError` deep inside the first
 * `put()`/`search()` rather than this library's typed error at construction.
 *
 * Both methods are required: documents are embedded with `embedDocuments()`
 * on `put()` and queries with `embedQuery()` on `search()`.
 *
 * The keys are checked first, so `{ dims, embed }` names the misspelt `embed`
 * rather than the `embeddings` it displaced. `null` is refused like any other
 * value that is not an object, where it used to mean no index; only
 * `undefined` does. `fields`, when given, must be an array of strings, the
 * rule a put's own `index` argument follows: a string reached the first put
 * and failed there as an upstream error.
 */
function assertUsableIndex(index: IndexConfig | undefined): void {
  if (index === undefined) return;
  assertShape(index, INDEX_KEYS, 'index');
  assertMembers(index.embeddings, EMBEDDINGS_MEMBERS, 'index.embeddings');
  if (index.fields !== undefined) assertStringArray(index.fields, 'index.fields');
}

/**
 * Reject a `vectorScoreDirection` outside the declared union.
 *
 * `toRelevanceScores` (store/internal/vector-index.ts) treats anything it does
 * not recognise as a no-op — the only safe default, since guessing would invert
 * a ranking — so a mistyped
 * or config-file-sourced value would otherwise leave a distance backend ranked
 * backwards with no error and no warning anywhere. Same premise as
 * {@link assertUsableIndex}: a JavaScript caller can pass a string the type
 * never admits.
 */
function assertScoreDirection(direction?: VectorScoreDirection): void {
  if (direction === undefined || VECTOR_SCORE_DIRECTIONS.includes(direction)) return;
  throw validationError(
    `vectorScoreDirection must be one of ${VECTOR_SCORE_DIRECTIONS.join(' | ')}; received ` +
      `${JSON.stringify(direction)}, which would be left in the backend's own direction and ` +
      'could rank a distance backend backwards',
    'vectorScoreDirection',
  );
}

/** Both in-memory caps must be positive integers; 0 would silently return nothing. */
function assertLimits(options: DynamoDBStoreOptions): void {
  if (options.maxScanItems !== undefined) {
    assertInteger(options.maxScanItems, 'maxScanItems', { min: 1, max: MAX_SCAN_ITEMS });
  }
  if (options.maxSearchCandidates !== undefined) {
    assertInteger(options.maxSearchCandidates, 'maxSearchCandidates', {
      min: 1,
      max: MAX_SEARCH_CANDIDATES,
    });
  }
}

/**
 * Validate the store's own options at construction; the shared ones are
 * `openAdapter`'s, which checks them before these.
 *
 * A `vectorBackend` without an `index` is rejected outright rather than
 * silently degrading: with no embeddings configured, every `put` would compute
 * no vector and instruct the backend to *delete* the item's entry instead of
 * indexing it, and `search()` would fall through to an unranked scan-order
 * listing with no `.score` field and no error — a semantic query returning a
 * normal-looking but meaningless response. `reconcileVectorIndex` already
 * refused this exact misconfiguration.
 *
 * Accepts: every option the store takes. The types describe the intended
 * shapes; this runs for the JavaScript caller the types never see, and for the
 * combinations no type can express — a backend without an index, an `index`
 * key `IndexConfig` does not declare, an `embeddings` object missing a method,
 * a direction outside its union.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming the offending option. Every failure is raised
 * at construction, where the fix is, rather than at the first put or search.
 */
export function assertStoreOptions(options: DynamoDBStoreOptions): void {
  assertLimits(options);
  if (options.vectorBackend && !options.index) {
    throw validationError(
      'vectorBackend requires a configured `index` (embeddings); without one no embedding ' +
        'is computed, every put would clear the item vector, and search would silently return ' +
        'unranked, score-less results',
      'vectorBackend',
    );
  }
  assertUsableIndex(options.index);
  assertScoreDirection(options.vectorScoreDirection);
}
