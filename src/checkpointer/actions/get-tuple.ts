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
      const item = await withDynamoDBRetry(
        async () => {
          return await params.client.get({
            TableName: params.checkpointsTableName,
            Key: {
              thread_id: configurable.thread_id,
              checkpoint_id: configurable.checkpoint_id,
            },
            ConsistentRead: true,
          });
        },
        { signal: params.signal },
      );
      return item.Item as CheckpointItem | undefined;
    } else {
      // Select metadata items only. We cannot bound by `checkpoint_id` in the
      // KeyCondition — any attempt to exclude payload items via `checkpoint_id
      // < 'PAYLOAD#'` silently drops metadata whose IDs sort lexicographically
      // above `PAYLOAD#` (e.g. anything starting with a lowercase letter,
      // which includes common IDs like `ckpt-1`, `checkpoint-2`, etc.), and
      // DynamoDB forbids primary-key attributes inside FilterExpression.
      // Instead, filter on the non-key `type` attribute that only metadata
      // items carry (`attribute_exists(#type)`). Payload items are never
      // returned, regardless of user ID character set.
      //
      // Because Limit applies *before* FilterExpression in DynamoDB, when
      // mixing metadata and payload pages we fetch a larger page and paginate
      // until a metadata item is found. For high-volume threads the ordering
      // still surfaces the newest metadata within the first 1-2 pages.
      const hasNsFilter = !!configurable.checkpoint_ns;
      const filterParts = ['attribute_exists(#type)'];
      if (hasNsFilter) filterParts.push('checkpoint_ns = :checkpoint_ns');

      const expressionValues: Record<string, unknown> = {
        ':thread_id': configurable.thread_id,
        ...(hasNsFilter && { ':checkpoint_ns': configurable.checkpoint_ns }),
      };

      let lastKey: Record<string, unknown> | undefined;
      do {
        const result = await withDynamoDBRetry(
          async () => {
            return await params.client.query({
              TableName: params.checkpointsTableName,
              KeyConditionExpression: 'thread_id = :thread_id',
              ExpressionAttributeValues: expressionValues,
              ExpressionAttributeNames: { '#type': 'type' },
              FilterExpression: filterParts.join(' AND '),
              ConsistentRead: true,
              ScanIndexForward: false, // Descending — newest first
              ExclusiveStartKey: lastKey,
            });
          },
          { signal: params.signal },
        );
        const items = result.Items as CheckpointItem[] | undefined;
        if (items && items.length > 0) {
          return items[0];
        }
        lastKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
      } while (lastKey);
      return undefined;
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
    // New split format — fetch payload item separately.
    // ConsistentRead must match the metadata read above: without it, a freshly-written
    // payload can be missing from an eventually-consistent read even though the metadata
    // item said it exists, producing spurious "payload not found" errors under write load.
    const payloadResult = await withDynamoDBRetry(
      async () => {
        return await params.client.get({
          TableName: params.checkpointsTableName,
          Key: {
            thread_id: item.thread_id,
            checkpoint_id: `${PAYLOAD_SK_PREFIX}${item.checkpoint_id}`,
          },
          ConsistentRead: true,
        });
      },
      { signal: params.signal },
    );

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
    // ConsistentRead is required here: putWrites races with getTuple under concurrent
    // workers, and an eventually-consistent Query can return a stale view that omits
    // writes that have already been acked.
    const writesResult = await withDynamoDBRetry(
      async () => {
        return await params.client.query({
          TableName: params.writesTableName,
          KeyConditionExpression:
            'thread_id_checkpoint_id_checkpoint_ns = :thread_id_checkpoint_id_checkpoint_ns',
          ExpressionAttributeValues: {
            ':thread_id_checkpoint_id_checkpoint_ns': Writer.getPartitionKey(item),
          },
          ConsistentRead: true,
          ExclusiveStartKey: writesLastEvaluatedKey,
        });
      },
      { signal: params.signal },
    );

    if (writesResult.Items) {
      allWriteItems.push(...(writesResult.Items as DynamoDBWriteItem[]));
    }
    writesLastEvaluatedKey = writesResult.LastEvaluatedKey;
  } while (writesLastEvaluatedKey);

  // Deserialize pending writes in parallel. Each write may involve an S3 download
  // plus decompress + serde — sequential awaits in a hot path were measurable on
  // checkpoints with many offloaded writes.
  const pendingWrites: CheckpointPendingWrite[] = await Promise.all(
    allWriteItems.map(async (writeItem): Promise<CheckpointPendingWrite> => {
      const write = Writer.fromDynamoDBItem(writeItem);
      let rawValue: Uint8Array = write.value;
      if (writeItem.s3_value_key) {
        if (!params.s3Offloader) {
          throw new Error(
            `Pending write references S3 key '${writeItem.s3_value_key}' but no S3 offloader is configured. ` +
              `Pass s3OffloadConfig when constructing DynamoDBSaver to read offloaded writes.`,
          );
        }
        rawValue = await params.s3Offloader.download(writeItem.s3_value_key);
      }
      const writeValue = params.compressor
        ? await params.compressor.decompress(rawValue)
        : rawValue;
      const value = await params.serde.loadsTyped(write.type, writeValue);
      return [write.task_id, write.channel, value];
    }),
  );

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
