/**
 * DynamoDB-based checkpoint saver for LangGraph
 * Provides persistent storage for checkpoints and pending writes
 */

import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointTuple,
  type CheckpointMetadata,
  type CheckpointListOptions,
  type PendingWrite,
  type ChannelVersions,
} from '@langchain/langgraph-checkpoint';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { RunnableConfig } from '@langchain/core/runnables';

import { deleteThreadAction, getTupleAction, putAction, putWritesAction } from './actions';
import type { CheckpointItem, DynamoDBSaverOptions } from './types';
import { validateListLimit, validateThreadId, deserializeCheckpointTuple } from './utils';
import { withDynamoDBRetry } from '../shared';

export class DynamoDBSaver extends BaseCheckpointSaver {
  private readonly ddbClient: DynamoDBClient;
  private readonly client: DynamoDBDocument;
  private readonly checkpointsTableName: string;
  private readonly writesTableName: string;
  private readonly ttlDays?: number;

  /**
   * Create a new DynamoDB checkpoint saver
   *
   * @param options - Configuration options for the saver
   * @param options.checkpointsTableName - Name of the DynamoDB table for checkpoints
   * @param options.writesTableName - Name of the DynamoDB table for writes
   * @param options.ttlDays - Optional TTL in days for stored items
   * @param options.serde - Optional serializer protocol
   * @param options.clientConfig - Optional DynamoDB client configuration
   */
  constructor(options: DynamoDBSaverOptions) {
    super(options.serde);
    this.checkpointsTableName = options.checkpointsTableName;
    this.writesTableName = options.writesTableName;
    this.ttlDays = options.ttlDays;
    this.ddbClient = new DynamoDBClient(options.clientConfig || {});
    this.client = DynamoDBDocument.from(this.ddbClient);
  }

  /**
   * Delete a thread and all its checkpoints and writes
   *
   * @param threadId - The thread ID to delete
   * @throws Error if validation fails or operation fails
   */
  async deleteThread(threadId: string): Promise<void> {
    return await deleteThreadAction({
      client: this.client,
      checkpointsTableName: this.checkpointsTableName,
      writesTableName: this.writesTableName,
      threadId,
    });
  }

  /**
   * Get a checkpoint tuple from DynamoDB
   *
   * @param config - Runnable configuration containing thread_id and optional checkpoint_id
   * @returns CheckpointTuple if found, undefined otherwise
   * @throws Error if validation fails or operation fails
   */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return await getTupleAction({
      client: this.client,
      checkpointsTableName: this.checkpointsTableName,
      writesTableName: this.writesTableName,
      serde: this.serde,
      config,
    });
  }

  /**
   * Save a checkpoint to DynamoDB
   *
   * @param config - Runnable configuration
   * @param checkpoint - Checkpoint to save
   * @param metadata - Checkpoint metadata
   * @param newVersions - Channel versions (not used in DynamoDB implementation)
   * @returns Updated RunnableConfig with checkpoint information
   * @throws Error if validation fails or operation fails
   */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    // eslint-disable-next-line unused-imports/no-unused-vars
    newVersions: ChannelVersions,
  ): Promise<RunnableConfig> {
    return await putAction({
      client: this.client,
      checkpointsTableName: this.checkpointsTableName,
      serde: this.serde,
      config,
      checkpoint,
      metadata,
      ttlDays: this.ttlDays,
    });
  }

  /**
   * Save pending writes to DynamoDB
   *
   * @param config - Runnable configuration
   * @param writes - Array of pending writes to save
   * @param taskId - Task ID for the writes
   * @throws Error if validation fails or operation fails
   */
  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    return await putWritesAction({
      client: this.client,
      writesTableName: this.writesTableName,
      serde: this.serde,
      config,
      writes,
      taskId,
      ttlDays: this.ttlDays,
    });
  }

  /**
   * List checkpoints for a thread
   *
   * @param config - Runnable configuration containing thread_id
   * @param options - List options including limit and before checkpoint
   * @yields CheckpointTuple objects in descending order
   * @throws Error if validation fails or operation fails
   */
  async *list(
    config: RunnableConfig,
    options: CheckpointListOptions | undefined,
  ): AsyncGenerator<CheckpointTuple> {
    const { limit, before } = options ?? {};
    const thread_id = config.configurable?.thread_id;

    // Validate thread_id
    if (typeof thread_id !== 'string') {
      throw new Error('thread_id must be a string');
    }
    validateThreadId(thread_id);

    // Validate limit if provided
    validateListLimit(limit);

    const expressionAttributeValues: Record<string, unknown> = {
      ':thread_id': thread_id,
    };
    let keyConditionExpression = 'thread_id = :thread_id';

    if (before?.configurable?.checkpoint_id) {
      keyConditionExpression += ' AND checkpoint_id < :before_checkpoint_id';
      expressionAttributeValues[':before_checkpoint_id'] = before.configurable.checkpoint_id;
    }

    const result = await withDynamoDBRetry(async () => {
      return await this.client.query({
        TableName: this.checkpointsTableName,
        KeyConditionExpression: keyConditionExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        Limit: limit,
        ScanIndexForward: false, // Descending order
      });
    });

    if (result.Items) {
      for (const item of result.Items as CheckpointItem[]) {
        yield await deserializeCheckpointTuple(item, this.serde);
      }
    }
  }
}
