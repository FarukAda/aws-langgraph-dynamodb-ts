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

import type { CheckpointItem } from '../types';

/**
 * Deserialize a DynamoDB checkpoint item into a CheckpointTuple
 *
 * @param item - DynamoDB checkpoint item
 * @param serde - Serializer protocol for deserialization
 * @returns CheckpointTuple with deserialized checkpoint and metadata
 */
export async function deserializeCheckpointTuple(
  item: CheckpointItem,
  serde: SerializerProtocol,
): Promise<CheckpointTuple> {
  const checkpoint = (await serde.loadsTyped(item.type, item.checkpoint)) as Checkpoint;
  const metadata = (await serde.loadsTyped(item.type, item.metadata)) as CheckpointMetadata;

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
