import { validateConfigurable } from './validate-configurable';
import { Writer } from './writer';
import { PutWritesActionParams } from '../types';
import { validateWritesCount, validateTTLDays, validateTaskId } from '../utils';
import { withDynamoDBRetry } from '../../shared';

/**
 * Save pending writes to DynamoDB
 *
 * @param params - Parameters for the put writes operation
 * @throws Error if validation fails or operation fails
 */
export const putWritesAction = async (params: PutWritesActionParams): Promise<void> => {
  const { thread_id, checkpoint_ns, checkpoint_id } = validateConfigurable(
    params.config.configurable,
  );

  if (checkpoint_id == null) {
    throw new Error('Missing checkpoint_id');
  }

  // Validate inputs
  validateWritesCount(params.writes.length);
  validateTaskId(params.taskId);
  validateTTLDays(params.ttlDays);

  const writeItems = await Promise.all(
    params.writes.map(async (write, idx) => {
      const [type, serializedValue] = await params.serde.dumpsTyped(write[1]);
      const item = new Writer({
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        task_id: params.taskId,
        idx,
        channel: write[0],
        type,
        value: serializedValue,
      });

      const dynamoItem = item.toDynamoDBItem();

      // FIX: Add TTL to the item that will actually be saved
      if (params.ttlDays !== undefined) {
        (dynamoItem as any).ttl = Math.floor(Date.now() / 1000) + params.ttlDays * 24 * 60 * 60;
      }

      return {
        PutRequest: {
          Item: dynamoItem, // Use the same item with TTL
        },
      };
    }),
  );

  // Batch writes in groups of 25 (DynamoDB limit)
  const batches = [];
  for (let i = 0; i < writeItems.length; i += 25) {
    batches.push(writeItems.slice(i, i + 25));
  }

  // Execute batches with retry logic
  for (const batch of batches) {
    await withDynamoDBRetry(async () => {
      await params.client.batchWrite({
        RequestItems: {
          [params.writesTableName]: batch,
        },
      });
    });
  }
};
