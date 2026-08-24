import { randomUUID } from 'node:crypto';

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

function isConditionalCheckFailed(error: { name?: string }): boolean {
  return error.name === 'ConditionalCheckFailedException';
}

/** Best-effort delete `items`' offloaded S3 objects, if an offloader is configured. */
async function cleanUpItems(
  context: CheckpointerContext,
  items: CheckpointWriteItem[],
): Promise<void> {
  if (!context.offloader) return;
  await cleanUpS3Orphans(
    context.offloader,
    collectS3Keys(items.map((item) => item.value)),
    'putWrites',
    context.logger,
  );
}

/**
 * Write special (negative-index) items unconditionally — overwrite is
 * correct there, matching every reference checkpointer implementation.
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
 * Outcome of {@link writeRegularItems}: never rejects. `orphaned`/`failed`
 * items never committed and are safe to clean up; every other item is now
 * permanently live and must never be touched, regardless of a sibling's fate.
 */
interface RegularWriteOutcome {
  orphaned: CheckpointWriteItem[];
  failed: CheckpointWriteItem[];
  error?: Error;
}

/**
 * Write regular (non-negative-index) items with a first-write-wins guard — a
 * re-executed task must not clobber an already-recorded write. Every
 * `PutCommand` fully settles (`Promise.allSettled`) before this resolves and
 * never rejects; a genuine failure is reported via `error`, not thrown.
 */
async function writeRegularItems(
  context: CheckpointerContext,
  items: CheckpointWriteItem[],
): Promise<RegularWriteOutcome> {
  const orphaned: CheckpointWriteItem[] = [];
  const failed: CheckpointWriteItem[] = [];
  let error: Error | undefined;
  const results = await Promise.allSettled(
    items.map((item) =>
      withDynamoDBRetry(() =>
        context.client.put({
          TableName: context.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK)',
        }),
      ),
    ),
  );
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') return;
    const reason = result.reason as Error;
    if (isConditionalCheckFailed(reason)) {
      orphaned.push(items[index]);
    } else {
      failed.push(items[index]);
      error = error ?? reason;
    }
  });
  return { orphaned, failed, error };
}

/**
 * Persist a task's intermediate writes for a checkpoint as one item per write.
 * Requires `checkpoint_id` in the config — writes always attach to a checkpoint.
 * Regular writes are first-write-wins (idempotent under task re-execution,
 * matching the reference checkpointer contract); special negative-index
 * writes (error/interrupt/scheduled/resume) are always overwritten. Both
 * write attempts run to full completion before any cleanup starts, and a
 * genuine failure's cleanup only ever targets items that never committed
 * (see {@link RegularWriteOutcome}).
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
    randomUUID(),
    ttlTimestamp,
  );
  const special = items.filter((item) => item.index < 0);
  const regular = items.filter((item) => item.index >= 0);
  const [specialError, regularOutcome] = await Promise.all([
    writeSpecialItems(context, special).catch((error: Error): Error => error),
    writeRegularItems(context, regular),
  ]);
  const firstError = specialError ?? regularOutcome.error;
  if (firstError) {
    const neverCommitted = [
      ...regularOutcome.orphaned,
      ...regularOutcome.failed,
      ...(specialError ? special : []),
    ];
    await cleanUpItems(context, neverCommitted);
    throw firstError;
  }
  await cleanUpItems(context, regularOutcome.orphaned);
}
