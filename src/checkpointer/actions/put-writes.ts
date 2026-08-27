import { randomUUID } from 'node:crypto';

import type { RunnableConfig } from '@langchain/core/runnables';
import type { PendingWrite } from '@langchain/langgraph-checkpoint';
import { WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint';

import type { PayloadDescriptor } from '../../shared/codec/codec';
import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { batchWriteAll } from '../../shared/dynamodb/batch-write';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import {
  BatchWriteAllIncompleteError,
  BatchWriteIncompleteError,
  ValidationError,
} from '../../shared/errors/errors';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import { readConfigurable } from '../internal/configurable';
import { buildWriteItems } from '../internal/item-writer';
import type { CheckpointerContext } from '../internal/setup';
import { validateTaskId } from '../internal/validation';
import type { CheckpointWriteItem } from '../types';

/**
 * True when the guard rejected a write — NOT evidence a competitor won: a
 * `PutCommand` retried after its response was lost can re-hit its own
 * committed row and fail identically; the two cases are indistinguishable.
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

/**
 * Dedup writes to the same special channel (last-write-wins) before upload,
 * so a discarded duplicate is never uploaded. A regular write's index comes
 * from its position here (post-dedup), not the caller's raw array — stable
 * across retries of an identical array, which is what first-write-wins needs.
 */
function dedupeWritesByIndex(writes: PendingWrite[]): PendingWrite[] {
  const byIndex = new Map<number, PendingWrite>();
  writes.forEach((write, positional) => {
    const index = WRITES_IDX_MAP[write[0]] ?? positional;
    byIndex.set(index, write);
  });
  return [...byIndex.values()];
}

/**
 * Read each special item's stored descriptor before it's overwritten —
 * mirrors store/actions/put.ts's readExisting. Keyed by SK (unique per
 * special channel per call).
 */
async function readPreviousDescriptors(
  context: CheckpointerContext,
  items: CheckpointWriteItem[],
): Promise<Map<string, PayloadDescriptor | undefined>> {
  const previous = new Map<string, PayloadDescriptor | undefined>();
  for (const item of items) {
    const result = await withDynamoDBRetry(() =>
      context.client.get({
        TableName: context.tableName,
        Key: { PK: item.PK, SK: item.SK },
        ConsistentRead: true,
        ProjectionExpression: '#v',
        ExpressionAttributeNames: { '#v': 'value' },
      }),
    );
    previous.set(item.SK, result.Item?.value as PayloadDescriptor | undefined);
  }
  return previous;
}

/**
 * Split `items` by outcome after a failed batch write (always a
 * BatchWriteAllIncompleteError — batchWriteAll's only throw): never-committed
 * items are safe to clean up their own upload, every other item its previous
 * one — unless a failed chunk's shape is unknown, in which case neither side
 * is touched (a leak beats stranding a live row). Uses `.name`, not
 * `instanceof` (banned repo-wide, see base-error.ts).
 */
function splitSpecialOutcome(
  items: CheckpointWriteItem[],
  error: BatchWriteAllIncompleteError,
): { committed: CheckpointWriteItem[]; neverCommitted: CheckpointWriteItem[] } {
  const neverCommittedSks = new Set<string>();
  let everyChunkTracked = true;
  for (const failedChunk of error.failedChunks) {
    if (failedChunk.name !== 'BatchWriteIncompleteError') {
      everyChunkTracked = false;
      continue;
    }
    for (const request of (failedChunk as BatchWriteIncompleteError).unprocessed) {
      /** Always a PutRequest echoing this submission — special writes never send DeleteRequests. */
      const { SK } = (request as { PutRequest: { Item: { SK: string } } }).PutRequest.Item;
      neverCommittedSks.add(SK);
    }
  }
  if (!everyChunkTracked) return { committed: [], neverCommitted: [] };
  return {
    committed: items.filter((item) => !neverCommittedSks.has(item.SK)),
    neverCommitted: items.filter((item) => neverCommittedSks.has(item.SK)),
  };
}

/** Best-effort delete the previous descriptors of `items` (now safely superseded). */
async function cleanUpPrevious(
  context: CheckpointerContext,
  items: CheckpointWriteItem[],
  previous: Map<string, PayloadDescriptor | undefined>,
): Promise<void> {
  if (!context.offloader) return;
  const descriptors = items
    .map((item) => previous.get(item.SK))
    .filter((descriptor): descriptor is PayloadDescriptor => descriptor !== undefined);
  await cleanUpS3Orphans(
    context.offloader,
    collectS3Keys(descriptors),
    'putWrites.special',
    context.logger,
  );
}

/**
 * Write special items unconditionally (overwrite is correct there). On
 * success, cleans up each item's superseded descriptor; on failure, only
 * confirmed never-committed items get their own new upload cleaned up.
 */
async function writeSpecialItemsWithCleanup(
  context: CheckpointerContext,
  items: CheckpointWriteItem[],
  previous: Map<string, PayloadDescriptor | undefined>,
): Promise<Error | undefined> {
  if (items.length === 0) return undefined;
  try {
    await batchWriteAll(
      context.client,
      context.tableName,
      items.map((item) => ({ PutRequest: { Item: item } })),
    );
  } catch (error) {
    const { committed, neverCommitted } = splitSpecialOutcome(
      items,
      error as BatchWriteAllIncompleteError,
    );
    await cleanUpItems(context, neverCommitted);
    await cleanUpPrevious(context, committed, previous);
    return error as Error;
  }
  await cleanUpPrevious(context, items, previous);
  return undefined;
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
/** Write regular items with a first-write-wins guard; settles fully and never rejects. */
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
 * Requires `checkpoint_id` in the config. Regular writes are first-write-wins
 * (the reference checkpointer contract); special negative-index writes always
 * overwrite, cleaning up whichever side a settled outcome confirms safe (see
 * {@link writeSpecialItemsWithCleanup}). Regular-write cleanup only ever
 * targets items known never to have committed (see {@link RegularWriteOutcome}),
 * never a lost guard — an upload can leak but a live row is never stranded.
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
    dedupeWritesByIndex(writes),
    randomUUID(),
    ttlTimestamp,
  );
  const special = items.filter((item) => item.index < 0);
  const regular = items.filter((item) => item.index >= 0);
  const previousSpecial = await readPreviousDescriptors(context, special);
  const [specialError, regularOutcome] = await Promise.all([
    writeSpecialItemsWithCleanup(context, special, previousSpecial),
    writeRegularItems(context, regular),
  ]);
  const firstError = specialError ?? regularOutcome.error;
  if (!firstError) return;
  await cleanUpItems(context, regularOutcome.failed);
  throw firstError;
}
