import type { RunnableConfig } from '@langchain/core/runnables';
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import type { PayloadDescriptor } from '../shared/codec/codec';
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

/** The lightweight `META#` item: structural fields + serialized metadata. */
export interface CheckpointMetaItem {
  PK: string;
  SK: string;
  /** Row format version; absent on rows written before it existed (see `table-schema.ts`). */
  v?: number;
  /** Recency-index keys; absent on rows written before the index existed. */
  gsi1pk?: string;
  gsi1sk?: string;
  threadId: string;
  checkpointNs: string;
  checkpointId: string;
  parentCheckpointId?: string;
  metadata: PayloadDescriptor;
  ttl?: number;
}

/** The heavy `PAYLOAD#` item: the serialized checkpoint. */
export interface CheckpointPayloadItem {
  PK: string;
  SK: string;
  /** Row format version; absent on rows written before it existed (see `table-schema.ts`). */
  v?: number;
  checkpoint: PayloadDescriptor;
  ttl?: number;
}

/** A `WRITE#` item: one pending write for a checkpoint/task. */
export interface CheckpointWriteItem {
  PK: string;
  SK: string;
  /** Row format version; absent on rows written before it existed (see `table-schema.ts`). */
  v?: number;
  taskId: string;
  index: number;
  channel: string;
  /** Identifies the `putWrites` call that produced this row (see item-writer). */
  writeGroup: string;
  /**
   * How many earlier writes in the same call already used this channel.
   * Optional: rows written before 0.9.0 carry none and read back as 0, which
   * is exactly the identity they were stored under.
   */
  occurrence?: number;
  value: PayloadDescriptor;
  ttl?: number;
}
