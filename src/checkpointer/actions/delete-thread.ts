import type { PayloadDescriptor } from '../../shared/codec/codec';
import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { BATCH_WRITE_MAX } from '../../shared/constants';
import { batchWriteAll } from '../../shared/dynamodb/batch-write';
import { paginateQuery } from '../../shared/dynamodb/paginate';
import { validateNonEmptyString } from '../../shared/validation/primitives';
import { partitionKey } from '../internal/keys';
import { partitionQuery } from '../internal/query';
import type { CheckpointerContext } from '../internal/setup';

interface DeletableItem {
  PK: string;
  SK: string;
  metadata?: PayloadDescriptor;
  checkpoint?: PayloadDescriptor;
  value?: PayloadDescriptor;
}

/** A bounded buffer of keys to delete plus the S3 descriptors they reference. */
interface DeleteBuffer {
  keys: { PK: string; SK: string }[];
  descriptors: PayloadDescriptor[];
}

/** Append an item's delete key and any offloaded payload descriptors to the buffer. */
function bufferItem(buffer: DeleteBuffer, item: DeletableItem): void {
  buffer.keys.push({ PK: item.PK, SK: item.SK });
  for (const descriptor of [item.metadata, item.checkpoint, item.value]) {
    if (descriptor) buffer.descriptors.push(descriptor);
  }
}

/** Delete the buffered keys and best-effort clean their S3 objects, then clear it. */
async function flushBuffer(context: CheckpointerContext, buffer: DeleteBuffer): Promise<void> {
  if (buffer.keys.length === 0) return;
  await batchWriteAll(
    context.client,
    context.tableName,
    buffer.keys.map((Key) => ({ DeleteRequest: { Key } })),
  );
  if (context.offloader) {
    await cleanUpS3Orphans(
      context.offloader,
      collectS3Keys(buffer.descriptors),
      'deleteThread',
      context.logger,
    );
  }
  buffer.keys = [];
  buffer.descriptors = [];
}

/**
 * Delete every checkpoint, payload, and write for a thread (all share the
 * thread's partition), best-effort deleting any offloaded S3 objects. Streams
 * the partition with unbounded pagination and flushes deletes in batches, so a
 * thread of any size is deleted to completion with bounded memory — never
 * silently truncated at the in-memory page caps.
 */
export async function deleteThread(context: CheckpointerContext, threadId: string): Promise<void> {
  validateNonEmptyString(threadId, 'threadId');
  const params = partitionQuery(context.tableName, partitionKey(threadId), { consistent: true });
  const buffer: DeleteBuffer = { keys: [], descriptors: [] };
  const pages = paginateQuery({
    client: context.client,
    params,
    maxItems: Number.POSITIVE_INFINITY,
    maxIterations: Number.POSITIVE_INFINITY,
  });
  for await (const raw of pages) {
    bufferItem(buffer, raw as DeletableItem);
    if (buffer.keys.length >= BATCH_WRITE_MAX) await flushBuffer(context, buffer);
  }
  await flushBuffer(context, buffer);
}
