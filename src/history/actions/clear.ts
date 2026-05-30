import type { PayloadDescriptor } from '../../shared/codec/codec';
import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { batchWriteAll } from '../../shared/dynamodb/batch-write';
import { paginateQuery } from '../../shared/dynamodb/paginate';
import type { DeleteWriteRequest } from '../../shared/dynamodb/types';
import { sessionItemsQuery } from '../internal/query';
import type { HistoryContext } from '../internal/setup';
import type { ChatMessageItem } from '../types';

/**
 * Delete a whole session: every message item plus the metadata item, removed in
 * one batched write. Any offloaded S3 objects for those messages are then
 * best-effort cleaned up.
 */
export async function clearSession(context: HistoryContext, sessionId: string): Promise<void> {
  const deletes: DeleteWriteRequest[] = [];
  const descriptors: PayloadDescriptor[] = [];
  for await (const raw of paginateQuery({
    client: context.client,
    params: sessionItemsQuery(context.tableName, sessionId),
  })) {
    const item = raw as ChatMessageItem;
    deletes.push({ DeleteRequest: { Key: { PK: item.PK, SK: item.SK } } });
    if (item.message) descriptors.push(item.message);
  }
  if (deletes.length === 0) return;
  await batchWriteAll(context.client, context.tableName, deletes);
  if (context.offloader) {
    await cleanUpS3Orphans(
      context.offloader,
      collectS3Keys(descriptors),
      'history.clear',
      context.logger,
    );
  }
}
