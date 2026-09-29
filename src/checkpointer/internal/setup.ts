/**
 * Hides which options the saver accepts, and how the saver is assembled from
 * them.
 *
 * The exhaustive key list of the constructor's options lives here,
 * compiler-checked against its type, beside the code that resolves those
 * options into the context every action receives. `list`'s and
 * `getDeltaChannelHistory`'s options have no list: LangGraph defines them, so
 * a key it adds is ignored rather than refused (decision record 28).
 */

import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import { type AdapterCore, type AdapterShell, openAdapter } from '../../shared/adapter.js';
import { allKeysOf } from '../../shared/validation/option-shape.js';
import type { DynamoDBSaverOptions } from '../types.js';

/**
 * The keys of the saver's constructor options, exhaustive in both directions:
 * `allKeysOf<T>` makes omitting or inventing one a compile error, so the list
 * cannot rot away from the type it guards. It lives with the feature because
 * the type it is checked against does; `shared/` knows no feature.
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
