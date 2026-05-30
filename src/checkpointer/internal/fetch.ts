import type { CheckpointPendingWrite } from '@langchain/langgraph-checkpoint';

import { paginateQuery } from '../../shared/dynamodb/paginate';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { CheckpointMetaItem, CheckpointPayloadItem, CheckpointWriteItem } from '../types';
import { toPendingWrites } from './item-reader';
import {
  metaSortKey,
  metaSortKeyPrefix,
  partitionKey,
  payloadSortKey,
  writeSortKeyPrefix,
} from './keys';
import { beginsWithQuery } from './query';
import type { CheckpointerContext } from './setup';

/** Fetch the target META item: by id when given, else the newest in the namespace. */
export async function fetchTargetMeta(
  context: CheckpointerContext,
  threadId: string,
  checkpointNs: string,
  checkpointId?: string,
): Promise<CheckpointMetaItem | undefined> {
  if (checkpointId !== undefined) {
    const result = await withDynamoDBRetry(() =>
      context.client.get({
        TableName: context.tableName,
        Key: { PK: partitionKey(threadId), SK: metaSortKey(checkpointNs, checkpointId) },
        ConsistentRead: true,
      }),
    );
    return result.Item as CheckpointMetaItem | undefined;
  }
  const params = beginsWithQuery(
    context.tableName,
    partitionKey(threadId),
    metaSortKeyPrefix(checkpointNs),
    {
      limit: 1,
      consistent: true,
    },
  );
  const result = await withDynamoDBRetry(() => context.client.query(params));
  return result.Items?.[0] as CheckpointMetaItem | undefined;
}

/** Fetch the PAYLOAD item for a checkpoint. */
export async function fetchPayload(
  context: CheckpointerContext,
  threadId: string,
  checkpointNs: string,
  checkpointId: string,
): Promise<CheckpointPayloadItem | undefined> {
  const result = await withDynamoDBRetry(() =>
    context.client.get({
      TableName: context.tableName,
      Key: { PK: partitionKey(threadId), SK: payloadSortKey(checkpointNs, checkpointId) },
      ConsistentRead: true,
    }),
  );
  return result.Item as CheckpointPayloadItem | undefined;
}

/** Fetch and decode every pending write for a checkpoint, in write order. */
export async function fetchPendingWrites(
  context: CheckpointerContext,
  threadId: string,
  checkpointNs: string,
  checkpointId: string,
): Promise<CheckpointPendingWrite[]> {
  const params = beginsWithQuery(
    context.tableName,
    partitionKey(threadId),
    writeSortKeyPrefix(checkpointNs, checkpointId),
    { ascending: true, consistent: true },
  );
  const items: CheckpointWriteItem[] = [];
  for await (const item of paginateQuery({ client: context.client, params })) {
    items.push(item as CheckpointWriteItem);
  }
  return toPendingWrites(context, items);
}
