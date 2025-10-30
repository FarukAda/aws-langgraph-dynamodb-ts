import { Writer } from './writer';
import { validateConfigurable } from './validate-configurable';
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointPendingWrite,
  CheckpointTuple,
} from '@langchain/langgraph-checkpoint';
import {
  CheckpointItem,
  DynamoDBWriteItem,
  GetTupleActionParams,
  ValidatedConfigurable,
} from '../types';
import { withDynamoDBRetry } from '../../shared';

/**
 * Get a checkpoint tuple from DynamoDB
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
          KeyConditionExpression: 'thread_id = :thread_id',
          ExpressionAttributeValues: {
            ':thread_id': configurable.thread_id,
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

  const checkpoint = (await params.serde.loadsTyped(item.type, item.checkpoint)) as Checkpoint;
  const metadata = (await params.serde.loadsTyped(item.type, item.metadata)) as CheckpointMetadata;

  const writesResult = await withDynamoDBRetry(async () => {
    return await params.client.query({
      TableName: params.writesTableName,
      KeyConditionExpression:
        'thread_id_checkpoint_id_checkpoint_ns = :thread_id_checkpoint_id_checkpoint_ns',
      ExpressionAttributeValues: {
        ':thread_id_checkpoint_id_checkpoint_ns': Writer.getPartitionKey(item),
      },
    });
  });

  const pendingWrites: CheckpointPendingWrite[] = [];
  if (writesResult.Items) {
    for (const writeItem of writesResult.Items as DynamoDBWriteItem[]) {
      const write = Writer.fromDynamoDBItem(writeItem);
      const value = await params.serde.loadsTyped(write.type, write.value);
      pendingWrites.push([write.task_id, write.channel, value]);
    }
  }

  return {
    config: {
      configurable: {
        thread_id: item.thread_id,
        checkpoint_ns: item.checkpoint_ns,
        checkpoint_id: item.checkpoint_id,
      },
    },
    checkpoint,
    metadata,
    parentConfig: item.parent_checkpoint_id
      ? {
          configurable: {
            thread_id: item.thread_id,
            checkpoint_ns: item.checkpoint_ns,
            checkpoint_id: item.parent_checkpoint_id,
          },
        }
      : undefined,
    pendingWrites,
  };
};
