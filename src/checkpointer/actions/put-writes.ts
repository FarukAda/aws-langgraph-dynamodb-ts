import type { RunnableConfig } from '@langchain/core/runnables';
import type { PendingWrite } from '@langchain/langgraph-checkpoint';

import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { batchWriteAll } from '../../shared/dynamodb/batch-write';
import { ValidationError } from '../../shared/errors/errors';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import { readConfigurable } from '../internal/configurable';
import { buildWriteItems } from '../internal/item-writer';
import { collectS3Keys } from '../internal/orphan-keys';
import type { CheckpointerContext } from '../internal/setup';

/**
 * Persist a task's intermediate writes for a checkpoint as one item per write.
 * Requires `checkpoint_id` in the config — writes always attach to a checkpoint.
 */
export async function putWrites(
  context: CheckpointerContext,
  config: RunnableConfig,
  writes: PendingWrite[],
  taskId: string,
): Promise<void> {
  const { threadId, checkpointNs, checkpointId } = readConfigurable(config);
  if (checkpointId === undefined) {
    throw new ValidationError('checkpoint_id is required to store writes', 'checkpoint_id');
  }
  if (writes.length === 0) return;
  const ttlTimestamp = context.ttl ? calculateTtlTimestamp(context.ttl) : undefined;
  const items = await buildWriteItems(
    context,
    threadId,
    checkpointNs,
    checkpointId,
    taskId,
    writes,
    ttlTimestamp,
  );
  try {
    await batchWriteAll(
      context.client,
      context.tableName,
      items.map((item) => ({ PutRequest: { Item: item } })),
    );
  } catch (error) {
    if (context.offloader) {
      await cleanUpS3Orphans(
        context.offloader,
        collectS3Keys(items.map((item) => item.value)),
        'putWrites',
        context.logger,
      );
    }
    throw error;
  }
}
