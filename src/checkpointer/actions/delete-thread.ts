import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { withDynamoDBRetry, batchWriteAllWithRetry } from '../../shared';
import {
  type CheckpointItem,
  type DeleteThreadActionParams,
  type DynamoDBWriteItem,
  PAYLOAD_SK_PREFIX,
} from '../types';
import { validateThreadId, CheckpointerValidationConstants } from '../utils';
import { Writer } from './writer';

/**
 * Raw DynamoDB item from the checkpoints table.
 * Could be a metadata item or a payload item — distinguished by SK prefix.
 */
interface RawCheckpointTableItem {
  thread_id: string;
  checkpoint_id: string;
  [key: string]: unknown;
}

/**
 * Delete a thread and all its checkpoints (metadata + payload items) and writes from DynamoDB
 *
 * @param params - Parameters for the delete thread operation
 * @throws Error if validation fails or too many items exist
 */
export const deleteThreadAction = async (params: DeleteThreadActionParams): Promise<void> => {
  // Validate thread ID
  validateThreadId(params.threadId);

  // Query returns BOTH metadata items and PAYLOAD# items for the thread
  const allItems: RawCheckpointTableItem[] = [];
  let lastEvaluatedKey: Record<string, unknown> | undefined;
  let iterationCount = 0;
  const MAX_ITERATIONS = 10;

  // Fetch all items with pagination and safety limits
  do {
    iterationCount++;
    if (iterationCount > MAX_ITERATIONS) {
      throw new Error('Delete operation exceeded maximum iteration limit');
    }

    const result = await withDynamoDBRetry(async () => {
      return await params.client.query({
        TableName: params.checkpointsTableName,
        KeyConditionExpression: 'thread_id = :thread_id',
        ExpressionAttributeValues: {
          ':thread_id': params.threadId,
        },
        Limit: 100, // Fetch in smaller batches
        ExclusiveStartKey: lastEvaluatedKey,
      });
    });

    if (result.Items && result.Items.length > 0) {
      allItems.push(...(result.Items as RawCheckpointTableItem[]));

      // Safety check: prevent deleting too many items at once
      if (allItems.length > CheckpointerValidationConstants.MAX_DELETE_BATCH_SIZE) {
        throw new Error(
          `Thread has too many items (>${CheckpointerValidationConstants.MAX_DELETE_BATCH_SIZE}). Delete operation aborted for safety.`,
        );
      }
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  if (allItems.length === 0) {
    return; // Nothing to delete
  }

  // Separate metadata items from payload items
  const metadataItems: CheckpointItem[] = [];
  for (const item of allItems) {
    // Skip items without checkpoint_id or those with PAYLOAD# prefix
    const ckptId = item.checkpoint_id;
    if (typeof ckptId === 'string' && !ckptId.startsWith(PAYLOAD_SK_PREFIX)) {
      metadataItems.push(item as unknown as CheckpointItem);
    }
  }

  // Collect S3 keys from metadata items only (payload items don't carry S3 refs)
  const s3KeysToDelete: string[] = [];
  if (params.s3Offloader) {
    for (const item of metadataItems) {
      if (item.s3_checkpoint_key) {
        s3KeysToDelete.push(item.s3_checkpoint_key);
      }
      if (item.s3_metadata_key) {
        s3KeysToDelete.push(item.s3_metadata_key);
      }
    }
  }

  // Delete ALL items (metadata + payload) using their actual PK+SK
  const checkpointDeleteRequests = allItems.map((item) => ({
    DeleteRequest: {
      Key: {
        thread_id: item.thread_id,
        checkpoint_id: item.checkpoint_id,
      },
    },
  }));

  await batchWriteAllWithRetry(
    params.client,
    params.checkpointsTableName,
    checkpointDeleteRequests,
  );

  // Fetch writes for metadata items only (payload items don't have associated writes)
  const allWriteDeleteRequests: Array<{
    DeleteRequest: {
      Key: {
        thread_id_checkpoint_id_checkpoint_ns: string;
        task_id_idx: string;
      };
    };
  }> = [];

  const QUERY_CONCURRENCY = 10;
  for (let i = 0; i < metadataItems.length; i += QUERY_CONCURRENCY) {
    const checkpointBatch = metadataItems.slice(i, i + QUERY_CONCURRENCY);
    const writesResults = await Promise.all(
      checkpointBatch.map((checkpoint) =>
        queryAllWritesForCheckpoint(params.client, params.writesTableName, checkpoint),
      ),
    );

    for (const writeItems of writesResults) {
      if (writeItems.length > 0) {
        const deleteRequests = writeItems.map((item) => ({
          DeleteRequest: {
            Key: {
              thread_id_checkpoint_id_checkpoint_ns: item.thread_id_checkpoint_id_checkpoint_ns,
              task_id_idx: item.task_id_idx,
            },
          },
        }));
        allWriteDeleteRequests.push(...deleteRequests);

        // Collect S3 keys from write items
        if (params.s3Offloader) {
          for (const item of writeItems) {
            if (item.s3_value_key) {
              s3KeysToDelete.push(item.s3_value_key);
            }
          }
        }
      }
    }
  }

  // Delete all writes using shared batch write utility
  await batchWriteAllWithRetry(params.client, params.writesTableName, allWriteDeleteRequests);

  // Clean up S3 offloaded data
  if (params.s3Offloader && s3KeysToDelete.length > 0) {
    await params.s3Offloader.deleteBatch(s3KeysToDelete);
  }
};

/**
 * Fetch all writes for a single checkpoint, paginating through results.
 * DynamoDB Query returns at most 1 MB per call — this loop ensures all writes are collected.
 *
 * @param client - DynamoDB Document client
 * @param tableName - Writes table name
 * @param checkpoint - Checkpoint metadata item
 * @returns All write items for this checkpoint
 */
async function queryAllWritesForCheckpoint(
  client: DynamoDBDocument,
  tableName: string,
  checkpoint: CheckpointItem,
): Promise<DynamoDBWriteItem[]> {
  const allItems: DynamoDBWriteItem[] = [];
  let lastKey: Record<string, unknown> | undefined;

  do {
    const result = await withDynamoDBRetry(async () => {
      return await client.query({
        TableName: tableName,
        KeyConditionExpression: 'thread_id_checkpoint_id_checkpoint_ns = :pk',
        ExpressionAttributeValues: {
          ':pk': Writer.getPartitionKey({
            thread_id: checkpoint.thread_id,
            checkpoint_id: checkpoint.checkpoint_id,
            checkpoint_ns: checkpoint.checkpoint_ns,
          }),
        },
        ExclusiveStartKey: lastKey,
      });
    });

    if (result.Items) {
      allItems.push(...(result.Items as DynamoDBWriteItem[]));
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);

  return allItems;
}
