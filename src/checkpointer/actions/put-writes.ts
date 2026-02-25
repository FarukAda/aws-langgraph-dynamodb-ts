import {
  calculateTTLTimestamp,
  calculateTTLTimestampFromSeconds,
  batchWriteAllWithRetry,
} from '../../shared';
import { PutWritesActionParams } from '../types';
import { validateWritesCount, validateTTLDays, validateTaskId } from '../utils';
import { validateConfigurable } from './validate-configurable';
import { Writer } from './writer';

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
      const [type, rawValue] = await params.serde.dumpsTyped(write[1]);

      // Compress after serialization if compressor is provided
      const serializedValue = params.compressor
        ? await params.compressor.compress(rawValue)
        : rawValue;

      // S3 offloading for large write values
      let s3ValueKey: string | undefined;
      let storedValue: Uint8Array = serializedValue;

      if (params.s3Offloader && params.s3Offloader.shouldOffload(serializedValue)) {
        s3ValueKey = await params.s3Offloader.upload(
          params.s3Offloader.buildKey(thread_id, checkpoint_id!, `write-${idx}`),
          serializedValue,
        );
        storedValue = new Uint8Array(0); // Empty placeholder in DynamoDB
      }

      const item = new Writer({
        thread_id,
        checkpoint_ns,
        checkpoint_id,
        task_id: params.taskId,
        idx,
        channel: write[0],
        type,
        value: storedValue,
      });

      const dynamoItem = item.toDynamoDBItem();

      // Add S3 reference if offloaded
      if (s3ValueKey) {
        dynamoItem.s3_value_key = s3ValueKey;
      }

      // Add TTL to the item that will actually be saved (ttlSeconds takes precedence)
      if (params.ttlSeconds !== undefined) {
        dynamoItem.ttl = calculateTTLTimestampFromSeconds(params.ttlSeconds);
      } else if (params.ttlDays !== undefined) {
        dynamoItem.ttl = calculateTTLTimestamp(params.ttlDays);
      }

      return {
        PutRequest: {
          Item: dynamoItem,
        },
      };
    }),
  );

  // Batch writes using shared utility with retry logic
  await batchWriteAllWithRetry(params.client, params.writesTableName, writeItems);
};
