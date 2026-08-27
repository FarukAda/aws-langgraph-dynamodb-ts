import type { PayloadDescriptor } from '../../shared/codec/codec';
import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { batchWriteAll } from '../../shared/dynamodb/batch-write';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import {
  BatchWriteAllIncompleteError,
  BatchWriteIncompleteError,
} from '../../shared/errors/errors';
import type { CheckpointWriteItem } from '../types';
import type { CheckpointerContext } from './setup';

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

/** Best-effort delete S3 objects backing `descriptors`, if an offloader is configured. */
async function deleteDescriptors(
  context: CheckpointerContext,
  descriptors: PayloadDescriptor[],
  label: string,
): Promise<void> {
  if (!context.offloader) return;
  await cleanUpS3Orphans(context.offloader, collectS3Keys(descriptors), label, context.logger);
}

/** Best-effort delete the previous descriptors of `items` (now safely superseded). */
async function cleanUpPrevious(
  context: CheckpointerContext,
  items: CheckpointWriteItem[],
  previous: Map<string, PayloadDescriptor | undefined>,
): Promise<void> {
  const descriptors = items
    .map((item) => previous.get(item.SK))
    .filter((descriptor): descriptor is PayloadDescriptor => descriptor !== undefined);
  await deleteDescriptors(context, descriptors, 'putWrites.special');
}

/**
 * Write special (negative-index) items unconditionally — overwrite is
 * correct there, matching every reference checkpointer implementation. Reads
 * each item's previous descriptor first, so a settled outcome can clean up
 * the correct side: the previous descriptor on success, each never-committed
 * item's own new upload on a confirmed non-commit, neither when the outcome
 * is genuinely ambiguous (see {@link splitSpecialOutcome}).
 */
export async function writeSpecialItemsWithCleanup(
  context: CheckpointerContext,
  items: CheckpointWriteItem[],
): Promise<Error | undefined> {
  if (items.length === 0) return undefined;
  const previous = await readPreviousDescriptors(context, items);
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
    await deleteDescriptors(
      context,
      neverCommitted.map((item) => item.value),
      'putWrites.special',
    );
    await cleanUpPrevious(context, committed, previous);
    return error as Error;
  }
  await cleanUpPrevious(context, items, previous);
  return undefined;
}
