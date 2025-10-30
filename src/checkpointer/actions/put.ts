import { validateConfigurable } from './validate-configurable';
import type { RunnableConfig } from '@langchain/core/runnables';
import { CheckpointItem, PutActionParams } from '../types';
import { validateCheckpointId, validateTTLDays } from '../utils';
import { withDynamoDBRetry } from '../../shared';

/**
 * Save a checkpoint to DynamoDB
 *
 * @param params - Parameters for the put operation
 * @returns RunnableConfig with the saved checkpoint information
 * @throws Error if validation fails or operation fails
 */
export const putAction = async (params: PutActionParams): Promise<RunnableConfig> => {
  const { thread_id } = validateConfigurable(params.config.configurable);

  // Validate checkpoint.id exists and is valid
  if (!params.checkpoint.id) {
    throw new Error('Checkpoint ID is required');
  }
  validateCheckpointId(params.checkpoint.id, true);
  validateTTLDays(params.ttlDays);

  const [type1, serializedCheckpoint] = await params.serde.dumpsTyped(params.checkpoint);
  const [type2, serializedMetadata] = await params.serde.dumpsTyped(params.metadata);

  if (type1 !== type2) {
    throw new Error('Failed to serialize checkpoint and metadata to the same type.');
  }

  const item: CheckpointItem & { ttl?: number } = {
    thread_id,
    checkpoint_ns: params.config.configurable?.checkpoint_ns ?? '',
    checkpoint_id: params.checkpoint.id,
    parent_checkpoint_id: params.config.configurable?.checkpoint_id,
    type: type1,
    checkpoint: serializedCheckpoint,
    metadata: serializedMetadata,
  };

  if (params.ttlDays !== undefined) {
    item.ttl = Math.floor(Date.now() / 1000) + params.ttlDays * 24 * 60 * 60;
  }

  // Execute with retry logic
  await withDynamoDBRetry(async () => {
    await params.client.put({
      TableName: params.checkpointsTableName,
      Item: item,
    });
  });

  return {
    configurable: {
      thread_id: item.thread_id,
      checkpoint_ns: item.checkpoint_ns,
      checkpoint_id: item.checkpoint_id,
    },
  };
};
