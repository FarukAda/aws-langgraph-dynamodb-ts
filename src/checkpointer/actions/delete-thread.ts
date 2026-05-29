import type { PayloadDescriptor } from '../../shared/codec/codec';
import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
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

/**
 * Delete every checkpoint, payload, and write for a thread (all share the
 * thread's partition), then best-effort delete any offloaded S3 objects.
 */
export async function deleteThread(context: CheckpointerContext, threadId: string): Promise<void> {
  validateNonEmptyString(threadId, 'threadId');
  const params = partitionQuery(context.tableName, partitionKey(threadId));
  const keys: { PK: string; SK: string }[] = [];
  const descriptors: PayloadDescriptor[] = [];
  for await (const raw of paginateQuery({ client: context.client, params })) {
    const item = raw as DeletableItem;
    keys.push({ PK: item.PK, SK: item.SK });
    for (const descriptor of [item.metadata, item.checkpoint, item.value]) {
      if (descriptor) descriptors.push(descriptor);
    }
  }
  if (keys.length === 0) return;
  await batchWriteAll(
    context.client,
    context.tableName,
    keys.map((Key) => ({ DeleteRequest: { Key } })),
  );
  if (context.offloader) {
    await cleanUpS3Orphans(
      context.offloader,
      collectS3Keys(descriptors),
      'deleteThread',
      context.logger,
    );
  }
}
