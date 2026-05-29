import type { Item } from '@langchain/langgraph-checkpoint';

import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { readStoreItem } from '../internal/item-mapper';
import { partitionKey, sortKey } from '../internal/keys';
import type { StoreContext } from '../internal/setup';
import type { StoreItemRecord } from '../types';

/** Retrieve a single item by namespace and key (strongly consistent), or null. */
export async function getItem(
  context: StoreContext,
  namespace: string[],
  key: string,
): Promise<Item | null> {
  const result = await withDynamoDBRetry(() =>
    context.client.get({
      TableName: context.tableName,
      Key: { PK: partitionKey(namespace), SK: sortKey(namespace, key) },
      ConsistentRead: true,
    }),
  );
  if (!result.Item) return null;
  return readStoreItem(context, result.Item as StoreItemRecord);
}
