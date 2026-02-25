import type { RunnableConfig } from '@langchain/core/runnables';

import {
  withDynamoDBRetry,
  calculateTTLTimestamp,
  calculateTTLTimestampFromSeconds,
} from '../../shared';
import {
  type CheckpointItem,
  type CheckpointPayloadItem,
  PAYLOAD_SK_PREFIX,
  type PutActionParams,
} from '../types';
import { validateCheckpointId, validateTTLDays } from '../utils';
import { validateConfigurable } from './validate-configurable';

/**
 * Save a checkpoint to DynamoDB as two items:
 * 1. Metadata item (SK = checkpoint_id) — lightweight, queried by list()
 * 2. Payload item  (SK = PAYLOAD#checkpoint_id) — heavy blob, fetched only by getTuple()
 *
 * Both items are written atomically via transactWrite.
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

  const [type1, rawCheckpoint] = await params.serde.dumpsTyped(params.checkpoint);
  const [type2, rawMetadata] = await params.serde.dumpsTyped(params.metadata);

  if (type1 !== type2) {
    throw new Error('Failed to serialize checkpoint and metadata to the same type.');
  }

  // Compress after serialization if compressor is provided
  const serializedCheckpoint = params.compressor
    ? await params.compressor.compress(rawCheckpoint)
    : rawCheckpoint;
  const serializedMetadata = params.compressor
    ? await params.compressor.compress(rawMetadata)
    : rawMetadata;

  // S3 offloading for large payloads
  let s3CheckpointKey: string | undefined;
  let s3MetadataKey: string | undefined;
  let storedCheckpoint: Uint8Array = serializedCheckpoint;
  let storedMetadata: Uint8Array = serializedMetadata;

  if (params.s3Offloader) {
    const checkpointId = params.checkpoint.id;
    if (params.s3Offloader.shouldOffload(serializedCheckpoint)) {
      s3CheckpointKey = await params.s3Offloader.upload(
        params.s3Offloader.buildKey(thread_id, checkpointId, 'checkpoint'),
        serializedCheckpoint,
      );
      storedCheckpoint = new Uint8Array(0); // Empty placeholder in DynamoDB
    }
    if (params.s3Offloader.shouldOffload(serializedMetadata)) {
      s3MetadataKey = await params.s3Offloader.upload(
        params.s3Offloader.buildKey(thread_id, checkpointId, 'metadata'),
        serializedMetadata,
      );
      storedMetadata = new Uint8Array(0); // Empty placeholder in DynamoDB
    }
  }

  // Compute TTL once for both items
  let ttl: number | undefined;
  if (params.ttlSeconds !== undefined) {
    ttl = calculateTTLTimestampFromSeconds(params.ttlSeconds);
  } else if (params.ttlDays !== undefined) {
    ttl = calculateTTLTimestamp(params.ttlDays);
  }

  const checkpointNs = params.config.configurable?.checkpoint_ns ?? '';
  const checkpointId = params.checkpoint.id;

  // Metadata item — lightweight, read by list() queries
  const metadataItem: CheckpointItem & { ttl?: number } = {
    thread_id,
    checkpoint_ns: checkpointNs,
    checkpoint_id: checkpointId,
    parent_checkpoint_id: params.config.configurable?.checkpoint_id,
    type: type1,
    metadata: storedMetadata,
    s3_checkpoint_key: s3CheckpointKey,
    s3_metadata_key: s3MetadataKey,
  };

  if (ttl !== undefined) {
    metadataItem.ttl = ttl;
  }

  // Payload item — heavy blob, fetched only by getTuple()
  const payloadItem: CheckpointPayloadItem & { ttl?: number } = {
    thread_id,
    checkpoint_id: `${PAYLOAD_SK_PREFIX}${checkpointId}`,
    checkpoint: storedCheckpoint,
  };

  if (ttl !== undefined) {
    payloadItem.ttl = ttl;
  }

  // Atomic write: both items must succeed or both fail
  await withDynamoDBRetry(async () => {
    await params.client.transactWrite({
      TransactItems: [
        {
          Put: {
            TableName: params.checkpointsTableName,
            Item: metadataItem,
          },
        },
        {
          Put: {
            TableName: params.checkpointsTableName,
            Item: payloadItem,
          },
        },
      ],
    });
  });

  return {
    configurable: {
      thread_id: metadataItem.thread_id,
      checkpoint_ns: metadataItem.checkpoint_ns,
      checkpoint_id: metadataItem.checkpoint_id,
    },
  };
};
