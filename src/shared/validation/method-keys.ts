import type { CheckpointListOptions } from '@langchain/langgraph-checkpoint';

import type { DeltaChannelHistoryOptions } from '../../checkpointer/types';
import type { GetMessagesOptions, ListSessionsOptions } from '../../history/types';
import type { ListNamespacesOptions, SearchOptions } from '../../store/types';
import type { CancelOptions } from '../options';
import { assertSignalLike } from './collaborators';
import { allKeysOf, assertShape } from './option-shape';

/**
 * The keys of each public method's option bag, exhaustive in both directions.
 *
 * These guard a *call*, not a constructor — `adapter-keys.ts` is the
 * constructor-options counterpart — and live apart from `options.ts`, which
 * holds the checks rather than the lists. `allKeysOf<T>` keeps each list from drifting
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
 * See {@link CANCEL_KEYS}. `ListNamespacesOptions` is pinned equal to
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
 * See {@link CANCEL_KEYS}. `DeltaChannelHistoryOptions` is pinned equal to
 * `BaseCheckpointSaver.getDeltaChannelHistory`'s own parameter type, the
 * contract that method implements, so this list is checked against it.
 */
export const DELTA_CHANNEL_HISTORY_KEYS = allKeysOf<DeltaChannelHistoryOptions>({
  config: 'config',
  channels: 'channels',
});

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
