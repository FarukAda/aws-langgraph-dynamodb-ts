import type { Item } from '@langchain/langgraph';

import type { GetOperationActionParams } from '../types';
import { validateNamespace, validateKey, validateUserId, withDynamoDBRetry } from '../utils';

/**
 * Get a memory item from DynamoDB
 *
 * @param params - Parameters for the get operation
 * @returns The item if found, null if not found
 * @throws Error if the operation fails or validation fails
 */
export const getOperationAction = async (
  params: GetOperationActionParams,
): Promise<Item | null> => {
  const { client, memoryTableName, userId, op } = params;

  // Validate inputs
  validateUserId(userId);
  validateNamespace(op.namespace);
  validateKey(op.key);

  const namespacePath = op.namespace.join('/');
  const sortKey = `${namespacePath}#${op.key}`;

  // Execute with retry logic
  const ddbItem = await withDynamoDBRetry(async () => {
    return await client.get({
      TableName: memoryTableName,
      Key: {
        user_id: userId,
        namespace_key: sortKey,
      },
    });
  });

  if (!ddbItem.Item) {
    return null;
  }

  return {
    key: ddbItem.Item.key,
    namespace: op.namespace,
    value: ddbItem.Item.value,
    createdAt: ddbItem.Item.createdAt,
    updatedAt: ddbItem.Item.updatedAt,
  };
};
