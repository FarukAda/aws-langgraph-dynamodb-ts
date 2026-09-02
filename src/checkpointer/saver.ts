import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';

import { guardPublic, guardPublicIterable } from '../shared/errors/boundary';
import type { CancelOptions } from '../shared/options';
import { lifecycleExpirationDays } from '../shared/validation/ttl';
import { deleteThread as deleteThreadAction } from './actions/delete-thread';
import { getCheckpointTuple } from './actions/get-tuple';
import { listCheckpoints } from './actions/list';
import { putCheckpoint } from './actions/put';
import { putWrites as putWritesAction } from './actions/put-writes';
import { type CheckpointerContext, setUpCheckpointer } from './internal/setup';
import type { DynamoDBSaverOptions } from './types';

/**
 * DynamoDB-backed LangGraph checkpoint saver. A thin orchestrator: it resolves
 * its collaborators once and delegates every operation to a focused action.
 * Every public method is the library's error boundary — a raw AWS SDK error
 * escaping an action surfaces as an `UpstreamError`.
 */
export class DynamoDBSaver extends BaseCheckpointSaver {
  private readonly context: CheckpointerContext;
  private readonly ownsClient: boolean;
  private readonly ddbClient: ReturnType<typeof setUpCheckpointer>['ddbClient'];

  constructor(options: DynamoDBSaverOptions) {
    super(options.serde);
    const setup = setUpCheckpointer(options, this.serde);
    this.context = setup.context;
    this.ownsClient = setup.ownsClient;
    this.ddbClient = setup.ddbClient;
  }

  /**
   * Read one checkpoint with its metadata and pending writes: the one
   * `checkpoint_id` names, else the newest in the namespace. Strongly
   * consistent, so a checkpoint just written is always seen. Returns
   * `undefined` for an unknown thread or checkpoint, or a config without a
   * thread.
   * @throws ValidationError for a malformed identifier; UpstreamError, RetryExhaustedError, AbortError (`config.signal`).
   */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return guardPublic('saver.getTuple', () => getCheckpointTuple(this.context, config));
  }

  /**
   * Stream checkpoints newest first: one namespace, every namespace of a
   * thread when `checkpoint_ns` is omitted, or every thread in the table when
   * `thread_id` is omitted (a table scan). Eventually consistent. `before`,
   * `filter` and `limit` follow the reference savers.
   * @remarks One read per page plus two per yielded tuple (see the README cost table).
   * @throws ValidationError, UpstreamError, RetryExhaustedError, AbortError.
   */
  list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    return guardPublicIterable('saver.list', listCheckpoints(this.context, config, options));
  }

  /**
   * Store a checkpoint and its metadata in one transaction and return the
   * config that addresses it. `config.checkpoint_id` becomes the parent;
   * `newVersions` names the channels that changed, and only those plus the
   * ones the parent stored are persisted. Last writer wins for a repeated
   * `checkpoint_id`.
   * @throws ValidationError; UpstreamError; RetryExhaustedError; AbortError; S3_OFFLOAD_FAILED when an offloaded payload cannot be uploaded.
   */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions?: ChannelVersions,
  ): Promise<RunnableConfig> {
    return guardPublic('saver.put', () =>
      putCheckpoint(this.context, config, checkpoint, metadata, newVersions),
    );
  }

  /**
   * Store a task's pending writes for the checkpoint `config` names, one row
   * per write, written in parallel. Regular writes are first-write-wins;
   * special channels (`__interrupt__`, `__resume__`, `__error__`,
   * `__scheduled__`) overwrite, guarded so two concurrent calls never orphan
   * an offloaded object.
   * @throws ValidationError when `checkpoint_id` is missing or a channel is malformed; UpstreamError; RetryExhaustedError; AbortError.
   */
  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    return guardPublic('saver.putWrites', () =>
      putWritesAction(this.context, config, writes, taskId),
    );
  }

  /**
   * Delete every checkpoint, payload and pending write of a thread and their
   * offloaded objects. Single pass: call it when the thread is quiescent.
   * @throws BatchWriteAllIncompleteError when a delete batch does not fully drain; UpstreamError; AbortError (`options.signal`).
   */
  async deleteThread(threadId: string, options?: CancelOptions): Promise<void> {
    return guardPublic('saver.deleteThread', () =>
      deleteThreadAction(this.context, threadId, options),
    );
  }

  /** Release owned resources (the underlying client and any S3 client). */
  destroy(): void {
    this.context.offloader?.destroy();
    if (this.ownsClient) this.ddbClient?.destroy();
  }

  /**
   * Provision an S3 lifecycle expiration rule matching the configured TTL, so
   * offloaded objects don't outlive their DynamoDB item forever. No-ops when
   * S3 offload or TTL isn't configured; throws when the bucket cannot be read
   * or written. Requires the `s3:GetLifecycleConfiguration` /
   * `s3:PutLifecycleConfiguration` bucket-level permissions (broader than the
   * object-level CRUD the rest of S3 offload needs) — call this once during
   * deployment/provisioning, not per-request.
   */
  async ensureS3LifecycleRule(): Promise<void> {
    return guardPublic('saver.ensureS3LifecycleRule', async () => {
      if (!this.context.offloader || !this.context.ttl) return;
      await this.context.offloader.ensureLifecycleRule(lifecycleExpirationDays(this.context.ttl));
    });
  }
}
