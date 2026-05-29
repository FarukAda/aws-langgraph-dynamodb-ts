import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';

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
    return getCheckpointTuple(this.context, config);
  }

  list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    return listCheckpoints(this.context, config, options);
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    return putCheckpoint(this.context, config, checkpoint, metadata);
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    return putWritesAction(this.context, config, writes, taskId);
  }

  async deleteThread(threadId: string): Promise<void> {
    return deleteThreadAction(this.context, threadId);
  }

  /** Release owned resources (the underlying client and any S3 client). */
  destroy(): void {
    this.context.offloader?.destroy();
    if (this.ownsClient) this.ddbClient?.destroy();
  }
}
