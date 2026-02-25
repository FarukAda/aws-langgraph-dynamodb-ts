/**
 * Checkpoint deserialization utilities
 * Provides centralized checkpoint tuple conversion
 */

import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
  SerializerProtocol,
} from '@langchain/langgraph-checkpoint';

import type { Compressor, S3Offloader } from '../../shared';
import type { CheckpointItem } from '../types';

/**
 * Deserialize a DynamoDB checkpoint metadata item into a CheckpointTuple.
 * The heavy checkpoint blob is provided separately (from a payload item or S3).
 *
 * @param item - DynamoDB checkpoint metadata item
 * @param checkpointData - Raw checkpoint blob (from payload item, S3, or legacy inline field)
 * @param serde - Serializer protocol for deserialization
 * @param compressor - Optional compressor for decompression (auto-detects gzip)
 * @param s3Offloader - Optional S3 offloader for downloading offloaded metadata
 * @returns CheckpointTuple with deserialized checkpoint and metadata
 */
export async function deserializeCheckpointTuple(
  item: CheckpointItem,
  checkpointData: Uint8Array,
  serde: SerializerProtocol,
  compressor?: Compressor,
  s3Offloader?: S3Offloader,
): Promise<CheckpointTuple> {
  // Download checkpoint from S3 if offloaded (checked first to maintain original S3 call order)
  let rawCheckpoint: Uint8Array = checkpointData;
  if (item.s3_checkpoint_key && s3Offloader) {
    rawCheckpoint = await s3Offloader.download(item.s3_checkpoint_key);
  }

  // Download metadata from S3 if offloaded, otherwise use DynamoDB data
  let rawMetadata: Uint8Array = item.metadata;
  if (item.s3_metadata_key && s3Offloader) {
    rawMetadata = await s3Offloader.download(item.s3_metadata_key);
  }

  const decompressedCheckpoint = compressor
    ? await compressor.decompress(rawCheckpoint)
    : rawCheckpoint;
  const decompressedMetadata = compressor ? await compressor.decompress(rawMetadata) : rawMetadata;

  const checkpoint = (await serde.loadsTyped(item.type, decompressedCheckpoint)) as Checkpoint;
  const metadata = (await serde.loadsTyped(item.type, decompressedMetadata)) as CheckpointMetadata;

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
  };
}
