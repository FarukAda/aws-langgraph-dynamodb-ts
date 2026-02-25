import type { CheckpointPendingWrite, CheckpointTuple } from '@langchain/langgraph-checkpoint';

import { withDynamoDBRetry } from '../../shared';
import {
  type CheckpointItem,
  type CheckpointPayloadItem,
  type DynamoDBWriteItem,
  type GetTupleActionParams,
  PAYLOAD_SK_PREFIX,
  type ValidatedConfigurable,
} from '../types';
import { deserializeCheckpointTuple } from '../utils';
import { validateConfigurable } from './validate-configurable';
import { Writer } from './writer';

/**
 * Get a checkpoint tuple from DynamoDB
 *
 * Fetches two items from the checkpoints table:
 * 1. Metadata item (SK = checkpoint_id) — contains metadata, S3 refs, type
 * 2. Payload item  (SK = PAYLOAD#checkpoint_id) — contains the heavy checkpoint blob
 *
 * For backward compatibility, also handles legacy single-item format where the
 * checkpoint blob is stored inline on the metadata item.
 *
 * @param params - Parameters for the get tuple operation
 * @returns CheckpointTuple if found, undefined otherwise
 * @throws Error if operation fails
 */
export const getTupleAction = async (
  params: GetTupleActionParams,
): Promise<CheckpointTuple | undefined> => {
  const getItem = async (configurable: ValidatedConfigurable) => {
    if (configurable.checkpoint_id != null) {
      const item = await withDynamoDBRetry(async () => {
        return await params.client.get({
          TableName: params.checkpointsTableName,
          Key: {
            thread_id: configurable.thread_id,
            checkpoint_id: configurable.checkpoint_id,
          },
        });
      });
      return item.Item as CheckpointItem | undefined;
    } else {
      const result = await withDynamoDBRetry(async () => {
        return await params.client.query({
          TableName: params.checkpointsTableName,
          KeyConditionExpression: 'thread_id = :thread_id AND checkpoint_id < :payload_prefix',
          ExpressionAttributeValues: {
            ':thread_id': configurable.thread_id,
            ':payload_prefix': PAYLOAD_SK_PREFIX,
            ...(configurable.checkpoint_ns && {
              ':checkpoint_ns': configurable.checkpoint_ns,
            }),
          },
          ...(configurable.checkpoint_ns && {
            FilterExpression: 'checkpoint_ns = :checkpoint_ns',
          }),
          Limit: 1,
          ConsistentRead: true,
          ScanIndexForward: false, // Descending order
        });
      });
      return result.Items?.[0] as CheckpointItem | undefined;
    }
  };

  const item = await getItem(validateConfigurable(params.config.configurable));
  if (!item) {
    return undefined;
  }

  // Fetch the payload item (heavy checkpoint blob)
  // Optimization: if checkpoint data is stored in S3, skip the payload fetch —
  // deserializeCheckpointTuple will download the real data from S3.
  let checkpointData: Uint8Array;
  if (item.s3_checkpoint_key) {
    // S3 offloaded — real data will be fetched by deserializeCheckpointTuple
    checkpointData = new Uint8Array(0);
  } else if (item.checkpoint && item.checkpoint.length > 0) {
    // Legacy single-item format — checkpoint blob is inline
    checkpointData = item.checkpoint;
  } else {
    // New split format — fetch payload item separately
    const payloadResult = await withDynamoDBRetry(async () => {
      return await params.client.get({
        TableName: params.checkpointsTableName,
        Key: {
          thread_id: item.thread_id,
          checkpoint_id: `${PAYLOAD_SK_PREFIX}${item.checkpoint_id}`,
        },
      });
    });

    const payloadItem = payloadResult.Item as CheckpointPayloadItem | undefined;
    if (!payloadItem) {
      throw new Error(
        `Checkpoint payload item not found for thread_id=${item.thread_id}, checkpoint_id=${item.checkpoint_id}`,
      );
    }
    checkpointData = payloadItem.checkpoint;
  }

  // Get pending writes for this checkpoint (with pagination for large result sets)
  const allWriteItems: DynamoDBWriteItem[] = [];
  let writesLastEvaluatedKey: Record<string, unknown> | undefined;

  do {
    const writesResult = await withDynamoDBRetry(async () => {
      return await params.client.query({
        TableName: params.writesTableName,
        KeyConditionExpression:
          'thread_id_checkpoint_id_checkpoint_ns = :thread_id_checkpoint_id_checkpoint_ns',
        ExpressionAttributeValues: {
          ':thread_id_checkpoint_id_checkpoint_ns': Writer.getPartitionKey(item),
        },
        ExclusiveStartKey: writesLastEvaluatedKey,
      });
    });

    if (writesResult.Items) {
      allWriteItems.push(...(writesResult.Items as DynamoDBWriteItem[]));
    }
    writesLastEvaluatedKey = writesResult.LastEvaluatedKey;
  } while (writesLastEvaluatedKey);

  const pendingWrites: CheckpointPendingWrite[] = [];
  for (const writeItem of allWriteItems) {
    const write = Writer.fromDynamoDBItem(writeItem);
    // Download from S3 if offloaded
    let rawValue: Uint8Array = write.value;
    if (writeItem.s3_value_key && params.s3Offloader) {
      rawValue = await params.s3Offloader.download(writeItem.s3_value_key);
    }
    // Decompress write value if compressor is provided (auto-detects gzip)
    const writeValue = params.compressor ? await params.compressor.decompress(rawValue) : rawValue;
    const value = await params.serde.loadsTyped(write.type, writeValue);
    pendingWrites.push([write.task_id, write.channel, value]);
  }

  // Deserialize the checkpoint tuple from metadata item + payload data
  const checkpointTuple = await deserializeCheckpointTuple(
    item,
    checkpointData,
    params.serde,
    params.compressor,
    params.s3Offloader,
  );

  // Add pending writes to the tuple
  return {
    ...checkpointTuple,
    pendingWrites,
  };
};
