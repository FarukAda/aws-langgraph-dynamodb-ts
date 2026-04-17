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
  MAX_LOOP_ITERATIONS,
  MAX_UNPROCESSED_RETRIES,
  resolveDynamoDBClient,
  INITIAL_BACKOFF_DELAY_MS,
  fullJitter,
  nextBackoffDelay,
  sleep,
} from '../shared';
import { deleteThreadAction, getTupleAction, putAction, putWritesAction } from './actions';
import type { CheckpointItem, CheckpointPayloadItem, DynamoDBSaverOptions } from './types';
import { PAYLOAD_SK_PREFIX } from './types';
import {
  validateCheckpointId,
  validateListLimit,
  validateThreadId,
  deserializeCheckpointTuple,
} from './utils';

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
    ({
      ddbClient: this.ddbClient,
      client: this.client,
      ownsClient: this.ownsClient,
    } = resolveDynamoDBClient(options));
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
   * @param options.signal - Optional AbortSignal for cancelling in-flight retries
   * @throws Error if validation fails or operation fails
   */
  async deleteThread(threadId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    return await deleteThreadAction({
      client: this.client,
      checkpointsTableName: this.checkpointsTableName,
      writesTableName: this.writesTableName,
      threadId,
      s3Offloader: this.s3Offloader,
      signal: options.signal,
    });
  }

  /**
   * Get a checkpoint tuple from DynamoDB
   *
   * @param config - Runnable configuration containing thread_id and optional checkpoint_id.
   *   `config.signal` is honored as an AbortSignal: in-flight retries short-circuit
   *   and the returned promise rejects with the signal's abort reason.
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
      signal: config.signal,
    });
  }

  /**
   * Save a checkpoint to DynamoDB
   *
   * @param config - Runnable configuration. `config.signal` is honored as an
   *   AbortSignal and short-circuits retry backoff.
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
      signal: config.signal,
    });
  }

  /**
   * Save pending writes to DynamoDB
   *
   * @param config - Runnable configuration. `config.signal` is honored as an
   *   AbortSignal and short-circuits retry backoff.
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
      signal: config.signal,
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
    // `config.signal` is LangChain's idiomatic AbortSignal field. We propagate
    // it into each retry cycle AND check it before yielding, so a consumer
    // calling `controller.abort()` during iteration stops producing items.
    const signal = config.signal;

    // Validate thread_id
    if (typeof thread_id !== 'string') {
      throw new Error('thread_id must be a string');
    }
    validateThreadId(thread_id);

    // Validate limit if provided
    validateListLimit(limit);

    // Validate `before` checkpoint_id — LangGraph passes this back verbatim from
    // a previous CheckpointTuple.config, but user callers can construct it
    // manually. Without validation a malformed before-id could slip past the
    // KeyCondition bound (payload items would get returned under `list({before})`).
    const beforeCheckpointId = before?.configurable?.checkpoint_id;
    if (beforeCheckpointId !== undefined) {
      if (typeof beforeCheckpointId !== 'string') {
        throw new Error('before.configurable.checkpoint_id must be a string');
      }
      validateCheckpointId(beforeCheckpointId, false);
    }

    const expressionAttributeValues: Record<string, unknown> = {
      ':thread_id': thread_id,
      ...(checkpoint_ns !== undefined && { ':checkpoint_ns': checkpoint_ns }),
    };

    // Filter to metadata items only via the non-key `type` attribute (payload
    // items don't carry `type`). We intentionally avoid using checkpoint_id in
    // the KeyCondition to exclude payload items — any lex-bound approach
    // silently drops metadata whose IDs sort above `PAYLOAD#`, which includes
    // the very common case of lowercase-letter-prefixed IDs.
    const filterParts = ['attribute_exists(#type)'];
    if (checkpoint_ns !== undefined) filterParts.push('checkpoint_ns = :checkpoint_ns');
    const filterExpression = filterParts.join(' AND ');

    // KeyCondition gates only by thread (and optional `before` sort-key bound).
    let keyConditionExpression = 'thread_id = :thread_id';

    if (before?.configurable?.checkpoint_id) {
      keyConditionExpression = 'thread_id = :thread_id AND checkpoint_id < :before_checkpoint_id';
      expressionAttributeValues[':before_checkpoint_id'] = before.configurable.checkpoint_id;
    }

    // When any server-side OR client-side filter reduces the returned set, we
    // drop the DynamoDB Limit: Limit is applied BEFORE FilterExpression, so a
    // small limit with heavy filtering truncates the result prematurely. The
    // metadata filter (from CheckpointListOptions.filter) and the checkpoint_ns
    // filter both qualify.
    const hasMetadataFilter = filter && Object.keys(filter).length > 0;
    const hasNsFilter = checkpoint_ns !== undefined;
    const hasAnyFilter = hasMetadataFilter || hasNsFilter;

    let yieldedCount = 0;
    let iterationCount = 0;
    let lastEvaluatedKey: Record<string, unknown> | undefined;

    do {
      // Safety net against pathological filter queries: if a thread has millions
      // of checkpoints and the filter matches almost none, the scan could loop
      // for minutes burning RCU. Abort with a clear error rather than hanging.
      iterationCount++;
      if (iterationCount > MAX_LOOP_ITERATIONS) {
        throw new Error(
          `list() exceeded ${MAX_LOOP_ITERATIONS} DynamoDB pages without reaching the requested limit. ` +
            `This usually indicates a filter that matches very few items in a large thread — ` +
            `narrow the filter, add a more selective namespace, or redesign with a GSI.`,
        );
      }

      const pageLimit = hasAnyFilter
        ? undefined
        : limit
          ? Math.max(1, limit - yieldedCount)
          : undefined;

      signal?.throwIfAborted();

      const result = await withDynamoDBRetry(
        async () => {
          return await this.client.query({
            TableName: this.checkpointsTableName,
            KeyConditionExpression: keyConditionExpression,
            ExpressionAttributeValues: expressionAttributeValues,
            ExpressionAttributeNames: { '#type': 'type' },
            FilterExpression: filterExpression,
            Limit: pageLimit,
            ScanIndexForward: false, // Descending order
            ExclusiveStartKey: lastEvaluatedKey,
          });
        },
        { signal },
      );

      if (result.Items) {
        const items = result.Items as CheckpointItem[];
        const payloadMap = await this.fetchCheckpointPayloadsBatch(items, signal);
        for (const item of items) {
          signal?.throwIfAborted();
          const checkpointData = payloadMap.get(item.checkpoint_id) ?? new Uint8Array(0);
          const tuple = await deserializeCheckpointTuple(
            item,
            checkpointData,
            this.serde,
            this.compressor,
            this.s3Offloader,
          );
          // Apply metadata filter: skip checkpoints that don't match all filter entries.
          if (hasMetadataFilter && !this.matchesFilter(tuple.metadata, filter)) {
            continue;
          }
          yield tuple;
          yieldedCount++;
          if (limit && yieldedCount >= limit) return;
        }
      }

      lastEvaluatedKey = result.LastEvaluatedKey;
    } while (lastEvaluatedKey);
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
    signal?: AbortSignal,
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
      let retryDelay = INITIAL_BACKOFF_DELAY_MS;
      let retryCount = 0;
      while (keys.length > 0) {
        const batchResult = await withDynamoDBRetry(
          async () => {
            return await this.client.batchGet({
              RequestItems: {
                [this.checkpointsTableName]: { Keys: keys },
              },
            });
          },
          { signal },
        );

        // Map results — BatchGetItem returns items in arbitrary order
        const responses = batchResult.Responses?.[this.checkpointsTableName];
        if (responses) {
          for (const response of responses as CheckpointPayloadItem[]) {
            // Sanity-check the sort key before trimming it. Without this, a corrupted
            // or migrated row missing the PAYLOAD# prefix would silently produce a
            // garbage `originalId` and ripple into the "payload not found" path below.
            if (!response.checkpoint_id?.startsWith(PAYLOAD_SK_PREFIX)) {
              throw new Error(
                `Unexpected payload item sort key in ${this.checkpointsTableName}: ` +
                  `expected to start with "${PAYLOAD_SK_PREFIX}" but got "${response.checkpoint_id}". ` +
                  `This indicates table corruption or a stale migration — investigate before retrying.`,
              );
            }
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
          // Full jitter so list() calls across concurrent workers don't synchronize
          // and re-pressure the partition on every retry cycle.
          await sleep(fullJitter(retryDelay), signal);
          retryDelay = nextBackoffDelay(retryDelay);
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
