import type { RunnableConfig } from '@langchain/core/runnables';
import type { PendingWrite } from '@langchain/langgraph-checkpoint';

import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { ValidationError } from '../../shared/errors/errors';
import { createUlidFactory } from '../../shared/ulid';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import { readConfigurable } from '../internal/configurable';
import { buildWriteItems } from '../internal/item-writer';
import type { CheckpointerContext } from '../internal/setup';
import { writeSpecialItemsWithCleanup } from '../internal/special-write-cleanup';
import { validateTaskId } from '../internal/validation';
import { isConditionalCheckFailed, reportGuardRejection } from '../internal/write-guard';
import type { CheckpointWriteItem } from '../types';

/**
 * Stamps each `putWrites` call, serving two purposes at once. It nonces every
 * S3 upload, so a repeated write never shares an object with an earlier
 * attempt. And because ULIDs are lexicographically time-ordered — and this
 * factory is strictly monotonic even within a single millisecond — it lets the
 * read side identify the *earliest* call that wrote a given channel (see
 * `dropSupersededWrites`). A random UUID nonces just as well but carries no
 * ordering, which would leave that choice arbitrary.
 */
const nextWriteGroup = createUlidFactory();

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
 * Outcome of {@link writeRegularItems}: never rejects. Only `failed` items
 * never reached DynamoDB and are safe to clean up — every other item is
 * either committed or turned away by the guard, and both back a live row.
 */
interface RegularWriteOutcome {
  failed: CheckpointWriteItem[];
  error?: Error;
}
/**
 * Write regular items with a first-write-wins guard. Every `PutCommand` fully
 * settles (`Promise.allSettled`) before this resolves and never rejects; a
 * genuine failure is reported via `error`, not thrown.
 */
async function writeRegularItems(
  context: CheckpointerContext,
  items: CheckpointWriteItem[],
): Promise<RegularWriteOutcome> {
  const failed: CheckpointWriteItem[] = [];
  let error: Error | undefined;
  const results = await Promise.allSettled(
    items.map((item) =>
      withDynamoDBRetry(() =>
        context.client.put({
          TableName: context.tableName,
          Item: item,
          ConditionExpression: 'attribute_not_exists(PK)',
          ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
        }),
      ),
    ),
  );
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') return;
    const reason = result.reason as Error;
    if (isConditionalCheckFailed(reason)) {
      reportGuardRejection(context, items[index], reason);
      return;
    }
    failed.push(items[index]);
    error = error ?? reason;
  });
  return { failed, error };
}
/**
 * Persist a task's intermediate writes for a checkpoint as one item per write.
 * Requires `checkpoint_id` in the config — writes always attach to a checkpoint.
 * Regular writes are first-write-wins (matching the reference checkpointer
 * contract); special negative-index writes always overwrite (see
 * {@link writeSpecialItemsWithCleanup}). Regular-write failure cleanup only
 * ever targets items known never to have committed (see
 * {@link RegularWriteOutcome}) — never a lost guard, so an upload can leak
 * but a live row can never be stranded pointing at a deleted object.
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
    nextWriteGroup(),
    ttlTimestamp,
  );
  const special = items.filter((item) => item.index < 0);
  const regular = items.filter((item) => item.index >= 0);
  const [specialError, regularOutcome] = await Promise.all([
    writeSpecialItemsWithCleanup(context, special),
    writeRegularItems(context, regular),
  ]);
  const firstError = specialError ?? regularOutcome.error;
  if (!firstError) return;
  await cleanUpItems(context, regularOutcome.failed);
  throw firstError;
}
