import type { Item } from '@langchain/langgraph-checkpoint';

import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { readStoreItem } from '../internal/item-mapper';
import { namespaceToPartition } from '../internal/keys';
import type { StoreContext } from '../internal/setup';
import type { StoreItemRecord } from '../types';

/** Retrieve a single item by namespace and key, or null when absent. */
export async function getItem(
  context: StoreContext,
  namespace: string[],
  key: string,
): Promise<Item | null> {
  const result = await withDynamoDBRetry(() =>
    context.client.get({
      TableName: context.tableName,
      Key: { PK: namespaceToPartition(namespace), SK: key },
    }),
  );
  if (!result.Item) return null;
  return readStoreItem(context, result.Item as StoreItemRecord);
}
