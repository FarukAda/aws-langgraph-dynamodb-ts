import {
  Checkpoint,
  CheckpointMetadata,
  PendingWrite,
  SerializerProtocol,
} from '@langchain/langgraph-checkpoint';
import type { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { RunnableConfig } from '@langchain/core/runnables';

/**
 * Configuration options for DynamoDBSaver
 *
 * @property checkpointsTableName - Name of the DynamoDB table for storing checkpoints
 * @property writesTableName - Name of the DynamoDB table for storing pending writes
 * @property ttlDays - Optional TTL in days for automatic item expiration (max 1825 days)
 * @property serde - Optional custom serializer protocol for checkpoint serialization
 * @property clientConfig - Optional DynamoDB client configuration
 */
export interface DynamoDBSaverOptions {
  checkpointsTableName: string;
  writesTableName: string;
  ttlDays?: number;
  serde?: SerializerProtocol;
  clientConfig?: DynamoDBClientConfig;
}

/**
 * Properties for creating a Writer instance
 *
 * @property thread_id - Unique identifier for the conversation thread
 * @property checkpoint_ns - Namespace for checkpoint isolation (default: '')
 * @property checkpoint_id - Unique identifier for the checkpoint
 * @property task_id - Unique identifier for the task that created the write
 * @property idx - Index of the write within the task (0-based)
 * @property channel - Channel name for the write
 * @property type - Type identifier for deserialization
 * @property value - Serialized value as binary data
 */
export interface WriterProps {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  task_id: string;
  idx: number;
  channel: string;
  type: string;
  value: Uint8Array;
}

/**
 * DynamoDB representation of a pending write
 * Uses composite keys for efficient querying
 *
 * @property thread_id_checkpoint_id_checkpoint_ns - Composite partition key (format: "thread_id:::checkpoint_id:::checkpoint_ns")
 * @property task_id_idx - Composite sort key (format: "task_id:::idx")
 * @property channel - Channel name for the write
 * @property type - Type identifier for deserialization
 * @property value - Serialized value as binary data
 */
export interface DynamoDBWriteItem {
  thread_id_checkpoint_id_checkpoint_ns: string;
  task_id_idx: string;
  channel: string;
  type: string;
  value: Uint8Array;
}

/**
 * DynamoDB representation of a checkpoint
 *
 * @property thread_id - Unique identifier for the conversation thread (partition key)
 * @property checkpoint_ns - Namespace for checkpoint isolation
 * @property checkpoint_id - Unique identifier for the checkpoint (sort key)
 * @property parent_checkpoint_id - Optional ID of the parent checkpoint for checkpoint chains
 * @property type - Type identifier for deserialization
 * @property checkpoint - Serialized checkpoint data as binary
 * @property metadata - Serialized metadata as binary
 */
export interface CheckpointItem {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string;
  parent_checkpoint_id?: string;
  type: string;
  checkpoint: Uint8Array;
  metadata: Uint8Array;
}

/**
 * Validated configurable parameters from RunnableConfig
 *
 * @property thread_id - Validated unique identifier for the conversation thread
 * @property checkpoint_ns - Validated namespace for checkpoint isolation (empty string if not provided)
 * @property checkpoint_id - Optional validated checkpoint identifier
 */
export interface ValidatedConfigurable {
  thread_id: string;
  checkpoint_ns: string;
  checkpoint_id: string | undefined;
}

/**
 * Parameters for deleteThread action
 *
 * @property client - DynamoDB Document client instance
 * @property checkpointsTableName - Name of the checkpoints table
 * @property writesTableName - Name of the pending writes table
 * @property threadId - Thread identifier to delete
 */
export interface DeleteThreadActionParams {
  client: DynamoDBDocument;
  checkpointsTableName: string;
  writesTableName: string;
  threadId: string;
}

/**
 * Parameters for getTuple action
 *
 * @property client - DynamoDB Document client instance
 * @property checkpointsTableName - Name of the checkpoints table
 * @property writesTableName - Name of the pending writes table
 * @property serde - Serialization protocol for checkpoint data
 * @property config - Runnable configuration with thread_id and optional checkpoint_id
 */
export interface GetTupleActionParams {
  client: DynamoDBDocument;
  checkpointsTableName: string;
  writesTableName: string;
  serde: SerializerProtocol;
  config: RunnableConfig;
}

/**
 * Parameters for put action
 *
 * @property client - DynamoDB Document client instance
 * @property checkpointsTableName - Name of the checkpoints table
 * @property serde - Serialization protocol for checkpoint data
 * @property config - Runnable configuration with thread_id and namespace
 * @property checkpoint - Checkpoint data to save
 * @property metadata - Checkpoint metadata to save
 * @property ttlDays - Optional TTL in days for automatic expiration (max 1825 days)
 */
export interface PutActionParams {
  client: DynamoDBDocument;
  checkpointsTableName: string;
  serde: SerializerProtocol;
  config: RunnableConfig;
  checkpoint: Checkpoint;
  metadata: CheckpointMetadata;
  ttlDays?: number;
}

/**
 * Parameters for putWrites action
 *
 * @property client - DynamoDB Document client instance
 * @property writesTableName - Name of the pending writes table
 * @property serde - Serialization protocol for write data
 * @property config - Runnable configuration with thread_id, checkpoint_id, and namespace
 * @property writes - Array of pending writes to save (max 1000 items)
 * @property taskId - Task identifier that created these writes
 * @property ttlDays - Optional TTL in days for automatic expiration (max 1825 days)
 */
export interface PutWritesActionParams {
  client: DynamoDBDocument;
  writesTableName: string;
  serde: SerializerProtocol;
  config: RunnableConfig;
  writes: PendingWrite[];
  taskId: string;
  ttlDays?: number;
}
