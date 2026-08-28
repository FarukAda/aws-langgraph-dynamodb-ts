import type { PayloadDescriptor } from '../../shared/codec/codec';
import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { batchWriteAll } from '../../shared/dynamodb/batch-write';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type {
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
 * BatchWriteAllIncompleteError — batchWriteAll's only throw, and every one of
 * its own failedChunks is in turn always a BatchWriteIncompleteError with an
 * accurate `unprocessed`, whichever of drainUnprocessedWrites's exit paths
 * produced it — see drain-unprocessed.ts): never-committed items are safe to
 * clean up their own upload, every other item its previous one. Uses `.name`,
 * not `instanceof` (banned repo-wide, see base-error.ts).
 */
function splitSpecialOutcome(
  items: CheckpointWriteItem[],
  error: BatchWriteAllIncompleteError,
): { committed: CheckpointWriteItem[]; neverCommitted: CheckpointWriteItem[] } {
  const neverCommittedSks = new Set<string>();
  for (const failedChunk of error.failedChunks as BatchWriteIncompleteError[]) {
    for (const request of failedChunk.unprocessed) {
      /** Always a PutRequest echoing this submission — special writes never send DeleteRequests. */
      const { SK } = (request as { PutRequest: { Item: { SK: string } } }).PutRequest.Item;
      neverCommittedSks.add(SK);
    }
  }
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
  await deleteDescriptors(context, descriptors, 'putWrites.special.previous');
}

/**
 * Write special (negative-index) items unconditionally — overwrite is
 * correct there, matching every reference checkpointer implementation. When
 * an offloader is configured, reads each item's previous descriptor first,
 * so a settled outcome can clean up the correct side: the previous
 * descriptor on success, each new upload on a confirmed non-commit (batch
 * write failed, or the previous-descriptor read itself failed before the
 * batch write was even attempted), neither when the outcome is genuinely
 * ambiguous (see {@link splitSpecialOutcome}). Never rejects — a failed read
 * is reported the same way a failed write is, via the return value —
 * because the caller runs this concurrently with writeRegularItems via
 * `Promise.all`, whose own regular-write cleanup depends on every branch of
 * that `Promise.all` resolving rather than short-circuiting on a reject.
 */
export async function writeSpecialItemsWithCleanup(
  context: CheckpointerContext,
  items: CheckpointWriteItem[],
): Promise<Error | undefined> {
  if (items.length === 0) return undefined;
  let previous: Map<string, PayloadDescriptor | undefined> = new Map();
  if (context.offloader) {
    try {
      previous = await readPreviousDescriptors(context, items);
    } catch (error) {
      await deleteDescriptors(
        context,
        items.map((item) => item.value),
        'putWrites.special.newUpload',
      );
      return error as Error;
    }
  }
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
      'putWrites.special.newUpload',
    );
    await cleanUpPrevious(context, committed, previous);
    return error as Error;
  }
  await cleanUpPrevious(context, items, previous);
  return undefined;
}
