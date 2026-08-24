import type { RunnableConfig } from '@langchain/core/runnables';
import type { PendingWrite } from '@langchain/langgraph-checkpoint';

import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { batchWriteAll } from '../../shared/dynamodb/batch-write';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { ValidationError } from '../../shared/errors/errors';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import { readConfigurable } from '../internal/configurable';
import { buildWriteItems } from '../internal/item-writer';
import type { CheckpointerContext } from '../internal/setup';
import { validateTaskId } from '../internal/validation';
import type { CheckpointWriteItem } from '../types';

function isConditionalCheckFailed(error: Error): boolean {
  return (error as { name?: string }).name === 'ConditionalCheckFailedException';
}

/**
 * Write special (negative-index) items unconditionally — overwrite is
 * correct for error/interrupt/scheduled/resume channels, matching every
 * reference checkpointer implementation.
 */
async function writeSpecialItems(
  context: CheckpointerContext,
  items: CheckpointWriteItem[],
): Promise<void> {
  if (items.length === 0) return;
  await batchWriteAll(
    context.client,
    context.tableName,
    items.map((item) => ({ PutRequest: { Item: item } })),
  );
}

/**
 * Write regular (non-negative-index) items with a first-write-wins guard,
 * matching the LangGraph checkpoint contract: a task re-executed after a
 * partial prior commit must not clobber an already-recorded write.
 */
async function writeRegularItems(
  context: CheckpointerContext,
  items: CheckpointWriteItem[],
): Promise<{ orphaned: CheckpointWriteItem[] }> {
  const orphaned: CheckpointWriteItem[] = [];
  await Promise.all(
    items.map(async (item) => {
      try {
        await withDynamoDBRetry(() =>
          context.client.put({
            TableName: context.tableName,
            Item: item,
            ConditionExpression: 'attribute_not_exists(PK)',
          }),
        );
      } catch (error) {
        if (!isConditionalCheckFailed(error as Error)) throw error;
        orphaned.push(item);
      }
    }),
  );
  return { orphaned };
}

/**
 * Persist a task's intermediate writes for a checkpoint as one item per write.
 * Requires `checkpoint_id` in the config — writes always attach to a checkpoint.
 * Regular writes are first-write-wins (idempotent under task re-execution,
 * matching the reference checkpointer contract); special negative-index
 * writes (error/interrupt/scheduled/resume) are always overwritten.
 */
export async function putWrites(
  context: CheckpointerContext,
  config: RunnableConfig,
  writes: PendingWrite[],
  taskId: string,
): Promise<void> {
  validateTaskId(taskId);
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
  const special = items.filter((item) => item.index < 0);
  const regular = items.filter((item) => item.index >= 0);
  try {
    const [, { orphaned }] = await Promise.all([
      writeSpecialItems(context, special),
      writeRegularItems(context, regular),
    ]);
    if (orphaned.length > 0 && context.offloader) {
      await cleanUpS3Orphans(
        context.offloader,
        collectS3Keys(orphaned.map((item) => item.value)),
        'putWrites',
        context.logger,
      );
    }
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
