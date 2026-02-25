/**
 * DynamoDB-based checkpoint saver for LangGraph
 * Provides persistent storage for checkpoints and pending writes
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointTuple,
  type CheckpointMetadata,
  type CheckpointListOptions,
  type PendingWrite,
  type ChannelVersions,
} from '@langchain/langgraph-checkpoint';

import {
  Compressor,
  S3Offloader,
  withDynamoDBRetry,
  getLogger,
  MAX_UNPROCESSED_RETRIES,
} from '../shared';
import { deleteThreadAction, getTupleAction, putAction, putWritesAction } from './actions';
import type { CheckpointItem, CheckpointPayloadItem, DynamoDBSaverOptions } from './types';
import { PAYLOAD_SK_PREFIX } from './types';
import { validateListLimit, validateThreadId, deserializeCheckpointTuple } from './utils';

/**
 * DynamoDB-based checkpoint saver for LangGraph.
 * Provides persistent storage for checkpoints and pending writes.
 *
 * @remarks
 * Uses the base class default for `getNextVersion()` (monotonic integers).
 * Channel versioning is internal to LangGraph's execution engine and does not
 * affect DynamoDB key ordering, which relies on checkpoint IDs.
 */
export class DynamoDBSaver extends BaseCheckpointSaver {
  private readonly ddbClient: DynamoDBClient | undefined;
  private readonly client: DynamoDBDocument;
  private readonly checkpointsTableName: string;
  private readonly writesTableName: string;
  private readonly ttlDays?: number;
  private readonly ttlSeconds?: number;
  private readonly compressor?: Compressor;
  private readonly s3Offloader?: S3Offloader;
  private readonly ownsClient: boolean;

  /**
   * Create a new DynamoDB checkpoint saver
   *
   * @param options - Configuration options for the saver
   * @param options.checkpointsTableName - Name of the DynamoDB table for checkpoints
   * @param options.writesTableName - Name of the DynamoDB table for writes
   * @param options.ttlDays - Optional TTL in days for stored items
   * @param options.ttlSeconds - Optional TTL in seconds (overrides ttlDays if both set)
   * @param options.serde - Optional serializer protocol
   * @param options.clientConfig - Optional DynamoDB client configuration
   * @param options.client - Optional pre-built DynamoDBDocument client (takes precedence over clientConfig)
   * @param options.compression - Optional compression configuration
   * @param options.s3OffloadConfig - Optional S3 offloading configuration
   */
  constructor(options: DynamoDBSaverOptions) {
    super(options.serde);
    this.checkpointsTableName = options.checkpointsTableName;
    this.writesTableName = options.writesTableName;
    this.ttlDays = options.ttlDays;
    this.ttlSeconds = options.ttlSeconds;
    if (options.client) {
      this.client = options.client;
      this.ddbClient = undefined;
      this.ownsClient = false;
    } else {
      this.ddbClient = new DynamoDBClient(options.clientConfig || {});
      this.client = DynamoDBDocument.from(this.ddbClient);
      this.ownsClient = true;
    }
    if (options.compression?.enabled) {
      this.compressor = new Compressor(options.compression);
    }
    if (options.s3OffloadConfig) {
      this.s3Offloader = new S3Offloader(options.s3OffloadConfig);
    }

    // Auto-configure S3 lifecycle rule when both TTL and S3 offloading are active
    if (this.s3Offloader && (this.ttlSeconds !== undefined || this.ttlDays !== undefined)) {
      const lifecycleDays =
        this.ttlSeconds !== undefined ? Math.ceil(this.ttlSeconds / 86400) : this.ttlDays!;
      this.s3Offloader.ensureLifecycleRule(lifecycleDays).catch((err: unknown) => {
        const message =
          err && typeof err === 'object' && 'message' in err
            ? (err as { message: string }).message
            : String(err);
        getLogger().warn(`Failed to configure S3 lifecycle rule: ${message}`);
      });
    }
  }

  /**
   * Release underlying DynamoDB and S3 client resources.
   * Call this when the saver is no longer needed to prevent resource leaks.
   * Skips DynamoDB client cleanup if a shared client was injected via options.
   */
  destroy(): void {
    if (this.ownsClient && this.ddbClient) {
      this.ddbClient.destroy();
    }
    this.s3Offloader?.destroy();
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
      s3Offloader: this.s3Offloader,
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
      compressor: this.compressor,
      s3Offloader: this.s3Offloader,
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
      ttlSeconds: this.ttlSeconds,
      compressor: this.compressor,
      s3Offloader: this.s3Offloader,
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
      ttlSeconds: this.ttlSeconds,
      compressor: this.compressor,
      s3Offloader: this.s3Offloader,
    });
  }

  /**
   * List checkpoints for a thread
   *
   * @param config - Runnable configuration containing thread_id
   * @param options - List options including limit, before checkpoint, and metadata filter
   * @yields CheckpointTuple objects in descending order
   * @throws Error if validation fails or operation fails
   */
  async *list(
    config: RunnableConfig,
    options: CheckpointListOptions | undefined,
  ): AsyncGenerator<CheckpointTuple> {
    const { limit, before, filter } = options ?? {};
    const thread_id = config.configurable?.thread_id;
    const checkpoint_ns = config.configurable?.checkpoint_ns as string | undefined;

    // Validate thread_id
    if (typeof thread_id !== 'string') {
      throw new Error('thread_id must be a string');
    }
    validateThreadId(thread_id);

    // Validate limit if provided
    validateListLimit(limit);

    const expressionAttributeValues: Record<string, unknown> = {
      ':thread_id': thread_id,
      ':payload_prefix': PAYLOAD_SK_PREFIX,
      ...(checkpoint_ns !== undefined && { ':checkpoint_ns': checkpoint_ns }),
    };

    // Filter by namespace when provided — applied after reading (costs RCU for
    // non-matching items, but avoids an additional GSI for the uncommon case).
    const filterExpression =
      checkpoint_ns !== undefined ? 'checkpoint_ns = :checkpoint_ns' : undefined;

    // Key condition excludes PAYLOAD# items — only metadata items are returned.
    // UUID checkpoint IDs (hex 0-9, a-f) sort before 'PAYLOAD#' in ASCII.
    let keyConditionExpression = 'thread_id = :thread_id AND checkpoint_id < :payload_prefix';

    if (before?.configurable?.checkpoint_id) {
      keyConditionExpression = 'thread_id = :thread_id AND checkpoint_id < :before_checkpoint_id';
      expressionAttributeValues[':before_checkpoint_id'] = before.configurable.checkpoint_id;
      // No need for :payload_prefix — before_checkpoint_id is always a UUID which is < PAYLOAD#
    }

    // When filter is active, skip DynamoDB-level Limit since metadata filtering
    // is a post-filter (metadata is stored as binary and cannot be filtered server-side).
    const hasFilter = filter && Object.keys(filter).length > 0;
    const queryLimit = hasFilter ? undefined : limit;

    const result = await withDynamoDBRetry(async () => {
      return await this.client.query({
        TableName: this.checkpointsTableName,
        KeyConditionExpression: keyConditionExpression,
        ExpressionAttributeValues: expressionAttributeValues,
        FilterExpression: filterExpression,
        Limit: queryLimit,
        ScanIndexForward: false, // Descending order
      });
    });

    let yieldedCount = 0;
    if (result.Items) {
      const items = result.Items as CheckpointItem[];
      const payloadMap = await this.fetchCheckpointPayloadsBatch(items);
      for (const item of items) {
        const checkpointData = payloadMap.get(item.checkpoint_id) ?? new Uint8Array(0);
        const tuple = await deserializeCheckpointTuple(
          item,
          checkpointData,
          this.serde,
          this.compressor,
          this.s3Offloader,
        );
        // Apply metadata filter: skip checkpoints that don't match all filter entries
        if (hasFilter && !this.matchesFilter(tuple.metadata, filter)) {
          continue;
        }
        yield tuple;
        yieldedCount++;
        if (limit && yieldedCount >= limit) return;
      }
    }

    // Paginate through remaining results if LastEvaluatedKey is present
    let lastEvaluatedKey = result.LastEvaluatedKey;
    while (lastEvaluatedKey) {
      const nextResult = await withDynamoDBRetry(async () => {
        return await this.client.query({
          TableName: this.checkpointsTableName,
          KeyConditionExpression: keyConditionExpression,
          ExpressionAttributeValues: expressionAttributeValues,
          FilterExpression: filterExpression,
          Limit: hasFilter ? undefined : limit ? limit - yieldedCount : undefined,
          ScanIndexForward: false,
          ExclusiveStartKey: lastEvaluatedKey,
        });
      });

      if (nextResult.Items) {
        const items = nextResult.Items as CheckpointItem[];
        const payloadMap = await this.fetchCheckpointPayloadsBatch(items);
        for (const item of items) {
          const checkpointData = payloadMap.get(item.checkpoint_id) ?? new Uint8Array(0);
          const tuple = await deserializeCheckpointTuple(
            item,
            checkpointData,
            this.serde,
            this.compressor,
            this.s3Offloader,
          );
          if (hasFilter && !this.matchesFilter(tuple.metadata, filter)) {
            continue;
          }
          yield tuple;
          yieldedCount++;
          if (limit && yieldedCount >= limit) return;
        }
      }

      lastEvaluatedKey = nextResult.LastEvaluatedKey;
    }
  }

  /**
   * Fetch checkpoint payloads for a batch of metadata items.
   * Uses BatchGetItem to fetch all payloads in one round trip instead of N+1 queries.
   * Items with S3 keys or legacy inline data are resolved without a remote call.
   *
   * @param items - Checkpoint metadata items from a query result
   * @returns Map from checkpoint_id to raw checkpoint data
   */
  private async fetchCheckpointPayloadsBatch(
    items: CheckpointItem[],
  ): Promise<Map<string, Uint8Array>> {
    const payloadMap = new Map<string, Uint8Array>();

    // Partition items into groups
    const splitItems: CheckpointItem[] = []; // Need PAYLOAD# fetch
    for (const item of items) {
      if (item.s3_checkpoint_key) {
        // S3 offloaded — deserializeCheckpointTuple will download from S3
        payloadMap.set(item.checkpoint_id, new Uint8Array(0));
      } else if (item.checkpoint && item.checkpoint.length > 0) {
        // Legacy inline — use item.checkpoint directly
        payloadMap.set(item.checkpoint_id, item.checkpoint);
      } else {
        // New split format — needs PAYLOAD# fetch
        splitItems.push(item);
      }
    }

    if (splitItems.length === 0) {
      return payloadMap;
    }

    // BatchGetItem supports up to 100 keys per call
    const BATCH_GET_MAX = 100;
    for (let i = 0; i < splitItems.length; i += BATCH_GET_MAX) {
      const batch = splitItems.slice(i, i + BATCH_GET_MAX);
      let keys = batch.map((item) => ({
        thread_id: item.thread_id,
        checkpoint_id: `${PAYLOAD_SK_PREFIX}${item.checkpoint_id}`,
      }));

      // Retry loop for UnprocessedKeys with exponential backoff
      let retryDelay = 100;
      let retryCount = 0;
      while (keys.length > 0) {
        const batchResult = await withDynamoDBRetry(async () => {
          return await this.client.batchGet({
            RequestItems: {
              [this.checkpointsTableName]: { Keys: keys },
            },
          });
        });

        // Map results — BatchGetItem returns items in arbitrary order
        const responses = batchResult.Responses?.[this.checkpointsTableName];
        if (responses) {
          for (const response of responses as CheckpointPayloadItem[]) {
            // Extract original checkpoint_id from PAYLOAD#<id> sort key
            const originalId = response.checkpoint_id.substring(PAYLOAD_SK_PREFIX.length);
            payloadMap.set(originalId, response.checkpoint);
          }
        }

        // Handle UnprocessedKeys with exponential backoff
        const unprocessed = batchResult.UnprocessedKeys?.[this.checkpointsTableName]?.Keys;
        if (unprocessed && unprocessed.length > 0) {
          retryCount++;
          if (retryCount > MAX_UNPROCESSED_RETRIES) {
            throw new Error(
              `Failed to fetch all checkpoint payloads after ${MAX_UNPROCESSED_RETRIES} retries. ` +
                `${unprocessed.length} keys remain unprocessed.`,
            );
          }
          await new Promise((resolve) => setTimeout(resolve, retryDelay));
          retryDelay = Math.min(retryDelay * 2, 5000);
          keys = unprocessed as typeof keys;
        } else {
          break;
        }
      }
    }

    // Verify all split items were fetched
    for (const item of splitItems) {
      if (!payloadMap.has(item.checkpoint_id)) {
        throw new Error(
          `Checkpoint payload item not found for thread_id=${item.thread_id}, checkpoint_id=${item.checkpoint_id}`,
        );
      }
    }

    return payloadMap;
  }

  /**
   * Check if checkpoint metadata matches all entries in the filter.
   * Each filter key must exactly match the corresponding metadata value.
   *
   * @param metadata - Deserialized checkpoint metadata
   * @param filter - Key-value pairs to match against metadata
   * @returns true if all filter entries match
   */
  private matchesFilter(
    metadata: CheckpointMetadata | undefined,
    filter: Record<string, unknown>,
  ): boolean {
    if (!metadata) return false;
    return Object.entries(filter).every(
      ([key, value]) => (metadata as unknown as Record<string, unknown>)[key] === value,
    );
  }
}
