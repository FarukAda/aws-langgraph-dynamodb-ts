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

/** Outcome of {@link writeRegularItems}: never rejects — genuine failures are reported via `error`. */
interface RegularWriteOutcome {
  orphaned: CheckpointWriteItem[];
  error?: Error;
}

/**
 * Write regular (non-negative-index) items with a first-write-wins guard — a
 * task re-executed after a partial prior commit must not clobber an already-
 * recorded write. Every `PutCommand` is let to fully settle
 * (`Promise.allSettled`) before this resolves, even if one fails outright,
 * and this function itself never rejects: a genuine failure is reported via
 * the returned `error`, not thrown — so cleanup never races an in-flight put.
 */
async function writeRegularItems(
  context: CheckpointerContext,
  items: CheckpointWriteItem[],
): Promise<RegularWriteOutcome> {
  const orphaned: CheckpointWriteItem[] = [];
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
      error = error ?? reason;
    }
  });
  return { orphaned, error };
}

/**
 * Persist a task's intermediate writes for a checkpoint as one item per write.
 * Requires `checkpoint_id` in the config — writes always attach to a checkpoint.
 * Regular writes are first-write-wins (idempotent under task re-execution,
 * matching the reference checkpointer contract); special negative-index
 * writes (error/interrupt/scheduled/resume) are always overwritten. Both
 * write attempts run to full completion — failures captured, never thrown —
 * before any S3 cleanup starts, so cleanup never races a still-in-flight
 * `PutCommand` from the other branch.
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
    if (context.offloader) {
      await cleanUpS3Orphans(
        context.offloader,
        collectS3Keys(items.map((item) => item.value)),
        'putWrites',
        context.logger,
      );
    }
    throw firstError;
  }
  if (regularOutcome.orphaned.length > 0 && context.offloader) {
    await cleanUpS3Orphans(
      context.offloader,
      collectS3Keys(regularOutcome.orphaned.map((item) => item.value)),
      'putWrites',
      context.logger,
    );
  }
}
