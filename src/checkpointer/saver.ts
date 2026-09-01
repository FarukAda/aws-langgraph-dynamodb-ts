import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';

import { guardPublic, guardPublicIterable } from '../shared/errors/boundary';
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

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return guardPublic('saver.getTuple', () => getCheckpointTuple(this.context, config));
  }

  list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    return guardPublicIterable('saver.list', listCheckpoints(this.context, config, options));
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    return guardPublic('saver.put', () =>
      putCheckpoint(this.context, config, checkpoint, metadata),
    );
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    return guardPublic('saver.putWrites', () =>
      putWritesAction(this.context, config, writes, taskId),
    );
  }

  async deleteThread(threadId: string): Promise<void> {
    return guardPublic('saver.deleteThread', () => deleteThreadAction(this.context, threadId));
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
