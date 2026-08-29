import type { Item } from '@langchain/langgraph-checkpoint';

import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { narrowStoreRecord, readStoreItem } from '../internal/item-mapper';
import { partitionKey, sortKey } from '../internal/keys';
import type { StoreContext } from '../internal/setup';
import { validateKey, validateNamespace } from '../internal/validation';

/** Retrieve a single item by namespace and key (strongly consistent), or null. */
export async function getItem(
  context: StoreContext,
  namespace: string[],
  key: string,
): Promise<Item | null> {
  validateNamespace(namespace);
  validateKey(key);
  const result = await withDynamoDBRetry(() =>
    context.client.get({
      TableName: context.tableName,
      Key: { PK: partitionKey(namespace), SK: sortKey(namespace, key) },
      ConsistentRead: true,
    }),
  );
  if (!result.Item) return null;
  /**
   * Narrow rather than cast. A foreign row sharing this key has no
   * `namespace`, and one carrying a `value` PayloadDescriptor in the same
   * shape a store item uses (a checkpointer WRITE row) would otherwise decode
   * cleanly and be handed back as the caller's own value.
   */
  const record = narrowStoreRecord(result.Item);
  if (!record) {
    context.logger.warn('store.get: ignored a row that is not a store item', {
      partitionKey: partitionKey(namespace),
      sortKey: sortKey(namespace, key),
    });
    return null;
  }
  return readStoreItem(context, record);
}
