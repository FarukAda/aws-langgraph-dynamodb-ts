/**
 * Hides the saver's own modules from the shapes a caller types against.
 *
 * The saver's options, the options its delta-channel walk accepts and the
 * narrowed `configurable` it reads are declared here, apart from the saver and
 * its actions, so a caller can type what it builds without importing either.
 * The delta-channel options are pinned equal to upstream's inline parameter
 * type, so they change only when LangGraph's do.
 */

import type { RunnableConfig } from '@langchain/core/runnables';
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import type { BaseAdapterOptions, CodecOptions } from '../shared/options';

/** Options for {@link DynamoDBSaver}. */
export type DynamoDBSaverOptions = BaseAdapterOptions &
  CodecOptions & {
    /**
     * Optional serializer override. The default is the base class's, which is
     * LangGraph's `JsonPlusSerializer` — **not** the plain JSON serializer the
     * store and chat-history adapters default to. The two differ on read as
     * well as on write: `JsonPlusSerializer` reconstructs a `Map`, a `Set`, a
     * `Uint8Array` or an allow-listed `langchain_core` class from the `lc`
     * record a stored row carries, so the row selects which constructor runs,
     * while plain JSON parses and reconstructs nothing. Pass the exported
     * `JSON_SERDE` for the narrower read path, at the cost of the JSON
     * projection the README's *Table schema* section tabulates.
     */
    serde?: SerializerProtocol;
  };

/**
 * Options {@link DynamoDBSaver.getDeltaChannelHistory} accepts: the object
 * `BaseCheckpointSaver.getDeltaChannelHistory` declares inline, named so a
 * caller can type the options it builds. A test pins it equal to upstream's
 * parameter type.
 */
export interface DeltaChannelHistoryOptions {
  /** The checkpoint to walk back from; must be an object. */
  config: RunnableConfig;
  /**
   * The delta channels to rebuild, as an array of strings; `[]` reads nothing
   * and returns `{}`.
   */
  channels: string[];
}

/** Narrowed shape of `RunnableConfig.configurable` the saver relies on. */
export interface CheckpointConfigurable {
  thread_id: string;
  checkpoint_ns?: string;
  checkpoint_id?: string;
  /** Legacy alias of `checkpoint_id` that older callers and API-shaped configs still emit. */
  thread_ts?: string;
}
