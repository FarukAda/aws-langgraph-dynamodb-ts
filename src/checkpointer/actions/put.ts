import type { RunnableConfig } from '@langchain/core/runnables';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import { readConfigurable } from '../internal/configurable';
import { buildCheckpointItems } from '../internal/item-writer';
import type { CheckpointerContext } from '../internal/setup';
import { validateCheckpointId } from '../internal/validation';

/**
 * Persist a checkpoint and its metadata as a transactional pair of META and
 * PAYLOAD items, returning the config that addresses the stored checkpoint. The
 * incoming `checkpoint_id` (if any) becomes the new checkpoint's parent.
 */
export async function putCheckpoint(
  context: CheckpointerContext,
  config: RunnableConfig,
  checkpoint: Checkpoint,
  metadata: CheckpointMetadata,
): Promise<RunnableConfig> {
  const { threadId, checkpointNs, checkpointId: parentCheckpointId } = readConfigurable(config);
  validateCheckpointId(checkpoint.id);
  const ttlTimestamp = context.ttl ? calculateTtlTimestamp(context.ttl) : undefined;
  const { meta, payload } = await buildCheckpointItems(
    context,
    threadId,
    checkpointNs,
    checkpoint,
    metadata,
    parentCheckpointId,
    ttlTimestamp,
  );
  try {
    await withDynamoDBRetry(() =>
      context.client.transactWrite({
        TransactItems: [
          { Put: { TableName: context.tableName, Item: meta } },
          { Put: { TableName: context.tableName, Item: payload } },
        ],
      }),
    );
  } catch (error) {
    if (context.offloader) {
      await cleanUpS3Orphans(
        context.offloader,
        collectS3Keys([meta.metadata, payload.checkpoint]),
        'put',
        context.logger,
      );
    }
    throw error;
  }
  return {
    configurable: {
      thread_id: threadId,
      checkpoint_ns: checkpointNs,
      checkpoint_id: checkpoint.id,
    },
  };
}
