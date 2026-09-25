/**
 * Hides which options the saver and its methods accept, and how the saver is
 * assembled from them.
 *
 * The exhaustive key list of every option bag — the constructor's, `list`'s,
 * `getDeltaChannelHistory`'s — lives here, compiler-checked against its type,
 * beside the code that resolves the constructor's options into the context
 * every action receives.
 */

import type { CheckpointListOptions, SerializerProtocol } from '@langchain/langgraph-checkpoint';

import { type AdapterCore, type AdapterShell, openAdapter } from '../../shared/adapter';
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

/** Resolved collaborators shared by every checkpointer action. */
export interface CheckpointerContext extends AdapterCore {
  serde: SerializerProtocol;
}

/** Result of wiring up a checkpointer from its options. */
export interface CheckpointerSetup {
  context: CheckpointerContext;
  shell: AdapterShell;
}

/**
 * Check the options, then resolve the client, offloader and serializer.
 *
 * Accepts: `options` — already held to the saver's key list by its constructor,
 * which must read `serde` before anything else runs; checked here before
 * anything is built, so no half-built saver exists when one is wrong. `serde` —
 * the serializer the base class resolved, which is the caller's own serializer
 * when they gave one.
 *
 * Returns: the context every action receives, and the shell that releases what
 * it holds — a client the caller passed in is never destroyed by `destroy()`.
 *
 * Throws: `VALIDATION` for an option or collaborator that fails a check,
 * naming the offending option.
 *
 * Guarantees: constructing a saver performs no I/O.
 */
export function setUpCheckpointer(
  options: DynamoDBSaverOptions,
  serde: SerializerProtocol,
): CheckpointerSetup {
  const shell = openAdapter(options, 'checkpointer');
  return { shell, context: { ...shell.core, serde } };
}
