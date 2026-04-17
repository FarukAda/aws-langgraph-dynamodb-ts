import { WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint';

import {
  calculateTTLTimestamp,
  calculateTTLTimestampFromSeconds,
  batchWriteAllWithRetry,
  cleanUpS3Orphans,
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

  // Compute TTL once (ttlSeconds takes precedence) — not per message.
  let ttl: number | undefined;
  if (params.ttlSeconds !== undefined) {
    ttl = calculateTTLTimestampFromSeconds(params.ttlSeconds);
  } else if (params.ttlDays !== undefined) {
    ttl = calculateTTLTimestamp(params.ttlDays);
  }

  const writeItems = await Promise.all(
    params.writes.map(async (write, positionalIdx) => {
      const [type, rawValue] = await params.serde.dumpsTyped(write[1]);

      // Compress after serialization if compressor is provided
      const serializedValue = params.compressor
        ? await params.compressor.compress(rawValue)
        : rawValue;

      // Special channels (__error__, __scheduled__, __interrupt__, __resume__) are
      // stored at the stable negative idx from WRITES_IDX_MAP so repeated writes
      // for the same taskId overwrite the correct dedicated slot. Regular writes
      // use their positional index. Matches memory.js:178 from langgraph-checkpoint.
      const channel = write[0];
      const idx = WRITES_IDX_MAP[channel] ?? positionalIdx;

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
        channel,
        type,
        value: storedValue,
      });

      const dynamoItem = item.toDynamoDBItem();
      if (s3ValueKey) dynamoItem.s3_value_key = s3ValueKey;
      if (ttl !== undefined) dynamoItem.ttl = ttl;

      return { PutRequest: { Item: dynamoItem } };
    }),
  );

  // Batch writes using shared utility with retry logic.
  // On failure, best-effort-clean any S3 objects we uploaded — errors during cleanup
  // are only logged since the lifecycle rule is the ultimate backstop.
  try {
    await batchWriteAllWithRetry(params.client, params.writesTableName, writeItems, {
      signal: params.signal,
    });
  } catch (err) {
    if (params.s3Offloader) {
      const keys = writeItems.map(
        (w) => (w.PutRequest.Item as { s3_value_key?: string }).s3_value_key,
      );
      await cleanUpS3Orphans(params.s3Offloader, keys, 'putWrites failure');
    }
    throw err;
  }
};
