import type {
  BaseCheckpointSaver,
  BaseStore,
  CheckpointListOptions,
} from '@langchain/langgraph-checkpoint';

import type { GetMessagesOptions, ListSessionsOptions } from '../../history/types';
import type { SearchOptions } from '../../store/types';
import type { CancelOptions } from '../options';
import { assertSignalLike } from './collaborators';
import { allKeysOf, assertShape } from './option-shape';

/**
 * The keys of each public method's option bag, exhaustive in both directions.
 *
 * These guard a *call*, not a constructor — `adapter-keys.ts` is the
 * constructor-options counterpart — and live apart from `options.ts`, which is
 * already near the 150-line cap. `allKeysOf<T>` keeps each list from drifting
 * from the type it guards the same way theirs do: an exhaustive list compiles,
 * omitting or inventing a key does not.
 */
export const CANCEL_KEYS = allKeysOf<CancelOptions>({ signal: 'signal' });

/** See {@link CANCEL_KEYS}. */
export const GET_MESSAGES_KEYS = allKeysOf<GetMessagesOptions>({
  limit: 'limit',
  before: 'before',
  signal: 'signal',
});

/** See {@link CANCEL_KEYS}. */
export const LIST_SESSIONS_KEYS = allKeysOf<ListSessionsOptions>({
  limit: 'limit',
  cursor: 'cursor',
  maxIterations: 'maxIterations',
  maxItems: 'maxItems',
  signal: 'signal',
});

/** See {@link CANCEL_KEYS}. */
export const STORE_SEARCH_KEYS = allKeysOf<SearchOptions>({
  filter: 'filter',
  limit: 'limit',
  offset: 'offset',
  query: 'query',
  signal: 'signal',
});

/** See {@link CANCEL_KEYS}. */
export const SAVER_LIST_KEYS = allKeysOf<CheckpointListOptions>({
  limit: 'limit',
  before: 'before',
  filter: 'filter',
});

/**
 * See {@link CANCEL_KEYS}. Named from `BaseStore`'s own signature, since
 * `DynamoDBStore.listNamespaces` takes upstream's options unchanged.
 */
export const STORE_LIST_NAMESPACES_KEYS = allKeysOf<
  NonNullable<Parameters<BaseStore['listNamespaces']>[0]>
>({ prefix: 'prefix', suffix: 'suffix', maxDepth: 'maxDepth', limit: 'limit', offset: 'offset' });

/**
 * See {@link CANCEL_KEYS}. Named from `BaseCheckpointSaver`'s own signature
 * rather than a type this package declares, since the upstream interface
 * (`@langchain/langgraph-checkpoint` `base.d.ts:107-110`) is the contract
 * `getDeltaChannelHistory` implements.
 */
export const DELTA_CHANNEL_HISTORY_KEYS = allKeysOf<
  Parameters<BaseCheckpointSaver['getDeltaChannelHistory']>[0]
>({ config: 'config', channels: 'channels' });

/**
 * Reject a `{ signal }` bag carrying a key this package does not read.
 *
 * Pulled out as one call because several methods across three classes take
 * only cancellation (`addMessages`, `addMessage`, `clear`,
 * `reconcileMessageCount`, `deleteThread`, `reconcileVectorIndex`) — one
 * shared check keeps their wording and their key list from drifting apart.
 *
 * Accepts: `options` — as the caller passed it; absent is left alone, since
 * there is nothing to check.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `options.<key>` for the first key this
 * package does not read, or `signal` for a value that is not AbortSignal-like.
 */
export function assertCancelOptions(options: CancelOptions | undefined): void {
  if (options === undefined) return;
  assertShape(options, CANCEL_KEYS, 'options');
  assertSignalLike(options.signal);
}
