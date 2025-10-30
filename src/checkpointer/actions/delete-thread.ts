import { CheckpointItem, DeleteThreadActionParams, DynamoDBWriteItem } from '../types';
import { Writer } from './writer';
import { validateThreadId, CheckpointerValidationConstants } from '../utils';
import { withDynamoDBRetry } from '../../shared';

/**
 * Delete a thread and all its checkpoints and writes from DynamoDB
 *
 * @param params - Parameters for the delete thread operation
 * @throws Error if validation fails or too many checkpoints exist
 */
export const deleteThreadAction = async (params: DeleteThreadActionParams): Promise<void> => {
  // Validate thread ID
  validateThreadId(params.threadId);

  const allCheckpoints: CheckpointItem[] = [];
  let lastEvaluatedKey: Record<string, any> | undefined;
  let iterationCount = 0;
  const MAX_ITERATIONS = 10;

  // Fetch checkpoints with pagination and safety limits
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
      allCheckpoints.push(...(result.Items as CheckpointItem[]));

      // Safety check: prevent deleting too many checkpoints at once
      if (allCheckpoints.length > CheckpointerValidationConstants.MAX_DELETE_BATCH_SIZE) {
        throw new Error(
          `Thread has too many checkpoints (>${CheckpointerValidationConstants.MAX_DELETE_BATCH_SIZE}). Delete operation aborted for safety.`,
        );
      }
    }

    lastEvaluatedKey = result.LastEvaluatedKey;
  } while (lastEvaluatedKey);

  if (allCheckpoints.length === 0) {
    return; // Nothing to delete
  }

  // Delete checkpoints in batches of 25 (DynamoDB limit)
  const checkpointDeleteRequests = allCheckpoints.map((item) => ({
    DeleteRequest: {
      Key: {
        thread_id: item.thread_id,
        checkpoint_id: item.checkpoint_id,
      },
    },
  }));

  for (let i = 0; i < checkpointDeleteRequests.length; i += 25) {
    const batch = checkpointDeleteRequests.slice(i, i + 25);
    await withDynamoDBRetry(async () => {
      await params.client.batchWrite({
        RequestItems: {
          [params.checkpointsTableName]: batch,
        },
      });
    });
  }

  // Delete associated writes - batch queries to avoid the N+1 problem
  const allWriteDeleteRequests: any[] = [];

  for (const checkpoint of allCheckpoints) {
    const writes = await withDynamoDBRetry(async () => {
      return await params.client.query({
        TableName: params.writesTableName,
        KeyConditionExpression: 'thread_id_checkpoint_id_checkpoint_ns = :pk',
        ExpressionAttributeValues: {
          ':pk': Writer.getPartitionKey({
            thread_id: checkpoint.thread_id,
            checkpoint_id: checkpoint.checkpoint_id,
            checkpoint_ns: checkpoint.checkpoint_ns,
          }),
        },
      });
    });

    if (writes.Items && writes.Items.length > 0) {
      const deleteRequests = (writes.Items as DynamoDBWriteItem[]).map((item) => ({
        DeleteRequest: {
          Key: {
            thread_id_checkpoint_id_checkpoint_ns: item.thread_id_checkpoint_id_checkpoint_ns,
            task_id_idx: item.task_id_idx,
          },
        },
      }));
      allWriteDeleteRequests.push(...deleteRequests);
    }
  }

  // Delete all writes in batches of 25
  for (let i = 0; i < allWriteDeleteRequests.length; i += 25) {
    const batch = allWriteDeleteRequests.slice(i, i + 25);
    await withDynamoDBRetry(async () => {
      await params.client.batchWrite({
        RequestItems: {
          [params.writesTableName]: batch,
        },
      });
    });
  }
};
