import { DynamoDBWriteItem, WriterProps } from '../types';
import {
  validateThreadId,
  validateCheckpointId,
  validateCheckpointNs,
  validateTaskId,
  validateChannel,
} from '../utils';

/**
 * Writer class for managing pending writes in DynamoDB
 * Handles serialization and composite key management
 */
export class Writer {
  /** Unique identifier for the conversation thread */
  readonly thread_id: string;
  /** Namespace for checkpoint isolation (default: '') */
  readonly checkpoint_ns: string;
  /** Unique identifier for the checkpoint */
  readonly checkpoint_id: string;
  /** Unique identifier for the task that created this write */
  readonly task_id: string;
  /** Index of the write within the task (0-based) */
  readonly idx: number;
  /** Channel name for the write */
  readonly channel: string;
  /** Type identifier for deserialization */
  readonly type: string;
  /** Serialized value as binary data */
  readonly value: Uint8Array;

  constructor({
    thread_id,
    checkpoint_ns,
    checkpoint_id,
    task_id,
    idx,
    channel,
    type,
    value,
  }: WriterProps) {
    // Validate all inputs
    validateThreadId(thread_id);
    validateCheckpointNs(checkpoint_ns);
    validateCheckpointId(checkpoint_id, true);
    validateTaskId(task_id);
    validateChannel(channel);

    if (!Number.isInteger(idx) || idx < 0) {
      throw new Error('idx must be a non-negative integer');
    }

    this.thread_id = thread_id;
    this.checkpoint_ns = checkpoint_ns;
    this.checkpoint_id = checkpoint_id;
    this.task_id = task_id;
    this.idx = idx;
    this.channel = channel;
    this.type = type;
    this.value = value;
  }

  toDynamoDBItem(): DynamoDBWriteItem {
    return {
      thread_id_checkpoint_id_checkpoint_ns: Writer.getPartitionKey({
        thread_id: this.thread_id,
        checkpoint_id: this.checkpoint_id,
        checkpoint_ns: this.checkpoint_ns,
      }),
      task_id_idx: [this.task_id, this.idx].join(Writer.separator()),
      channel: this.channel,
      type: this.type,
      value: this.value,
    };
  }

  /**
   * Deserialize a Writer instance from a DynamoDB item
   *
   * @param item - DynamoDB write item
   * @returns Writer instance
   * @throws Error if parsing fails or data is invalid
   */
  static fromDynamoDBItem({
    thread_id_checkpoint_id_checkpoint_ns,
    task_id_idx,
    channel,
    type,
    value,
  }: DynamoDBWriteItem): Writer {
    const parts = thread_id_checkpoint_id_checkpoint_ns.split(this.separator());
    if (parts.length !== 3) {
      throw new Error(`Invalid partition key format: expected 3 parts, got ${parts.length}`);
    }
    const [thread_id, checkpoint_id, checkpoint_ns] = parts;

    const idxParts = task_id_idx.split(this.separator());
    if (idxParts.length !== 2) {
      throw new Error(`Invalid sort key format: expected 2 parts, got ${idxParts.length}`);
    }
    const [task_id, idxStr] = idxParts;

    const idx = parseInt(idxStr, 10);
    if (isNaN(idx)) {
      throw new Error(`Invalid idx value: ${idxStr}`);
    }

    return new Writer({
      thread_id,
      checkpoint_ns,
      checkpoint_id,
      task_id,
      idx,
      channel,
      type,
      value,
    });
  }

  /**
   * Generate a partition key for DynamoDB from thread, checkpoint, and namespace
   *
   * @param params - Thread ID, checkpoint ID, and namespace
   * @returns Composite partition key
   */
  static getPartitionKey({
    thread_id,
    checkpoint_id,
    checkpoint_ns,
  }: {
    thread_id: string;
    checkpoint_id: string;
    checkpoint_ns: string;
  }): string {
    return [thread_id, checkpoint_id, checkpoint_ns].join(this.separator());
  }

  /**
   * Get the separator used for composite keys
   * Note: Input validation ensures this separator cannot be in any component
   */
  static separator() {
    return ':::';
  }
}
