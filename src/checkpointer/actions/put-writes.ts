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

/**
 * True when the first-write-wins guard rejected a write — NOT evidence a
 * *competitor* wrote that row. A `PutCommand` retried after its response was
 * lost (`ETIMEDOUT`/`NetworkingError`/`ECONNRESET`) re-hits the row it
 * committed itself and fails identically; the two cases are indistinguishable.
 */
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

/** Dedup by sort key (last-write-wins), matching LangGraph's special-write semantics. */
function dedupeBySortKey(items: CheckpointWriteItem[]): CheckpointWriteItem[] {
  return [...new Map(items.map((item) => [item.SK, item])).values()];
}

/**
 * Write special (negative-index) items unconditionally — overwrite is correct
 * there, matching every reference checkpointer implementation. Their key is
 * deterministic, so a failed batch never triggers S3 cleanup here either: the
 * next write to the same channel overwrites the same key (self-healing);
 * deleting now could strand a row a previous call already committed.
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
        }),
      ),
    ),
  );
  results.forEach((result, index) => {
    if (result.status === 'fulfilled') return;
    const reason = result.reason as Error;
    if (isConditionalCheckFailed(reason)) {
      context.logger.debug('putWrites: lost the guard', { sortKey: items[index].SK });
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
 * {@link writeSpecialItems}). Failure cleanup only ever targets regular items
 * known never to have committed (see {@link RegularWriteOutcome}) — never a
 * special item or a lost guard, so an upload can leak but a live row can
 * never be stranded pointing at a deleted object.
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
  const special = dedupeBySortKey(items.filter((item) => item.index < 0));
  const regular = items.filter((item) => item.index >= 0);
  const [specialError, regularOutcome] = await Promise.all([
    writeSpecialItems(context, special).catch((error: Error): Error => error),
    writeRegularItems(context, regular),
  ]);
  const firstError = specialError ?? regularOutcome.error;
  if (!firstError) return;
  await cleanUpItems(context, regularOutcome.failed);
  throw firstError;
}
