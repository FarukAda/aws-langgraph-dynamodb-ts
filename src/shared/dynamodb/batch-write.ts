import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { BATCH_WRITE_MAX } from '../constants';
import { BatchWriteAllIncompleteError } from '../errors/errors';
import { DrainOptions, drainUnprocessedWrites } from './drain-unprocessed';
import type { WriteRequest } from './types';

/**
 * Write an arbitrary number of requests, chunked into batches of 25 (the
 * BatchWriteItem limit). Every chunk is attempted regardless of an earlier
 * chunk's failure — order-independent writes (deletes/puts) should never
 * lose "later" chunks just because an earlier one failed. If any chunk fails,
 * throws {@link BatchWriteAllIncompleteError} reporting exactly how many
 * chunks succeeded vs. failed once every chunk has been attempted.
 */
export async function batchWriteAll(
  client: DynamoDBDocument,
  tableName: string,
  requests: WriteRequest[],
  options: DrainOptions = {},
): Promise<void> {
  const totalChunks = Math.ceil(requests.length / BATCH_WRITE_MAX);
  let succeededChunks = 0;
  const failedChunks: Error[] = [];
  for (let offset = 0; offset < requests.length; offset += BATCH_WRITE_MAX) {
    const chunk = requests.slice(offset, offset + BATCH_WRITE_MAX);
    try {
      await drainUnprocessedWrites(client, tableName, chunk, options);
      succeededChunks += 1;
    } catch (error) {
      failedChunks.push(error as Error);
    }
  }
  if (failedChunks.length > 0) {
    throw new BatchWriteAllIncompleteError(succeededChunks, totalChunks, failedChunks);
  }
}
