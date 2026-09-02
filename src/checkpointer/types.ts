import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import type { PayloadDescriptor } from '../shared/codec/codec';
import type { BaseAdapterOptions, CodecOptions } from '../shared/options';

/** Options for {@link DynamoDBSaver}. */
export type DynamoDBSaverOptions = BaseAdapterOptions &
  CodecOptions & {
    /** Optional serializer override (defaults to LangGraph's JSON serializer). */
    serde?: SerializerProtocol;
  };

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
  checkpoint: PayloadDescriptor;
  ttl?: number;
}

/** A `WRITE#` item: one pending write for a checkpoint/task. */
export interface CheckpointWriteItem {
  PK: string;
  SK: string;
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
