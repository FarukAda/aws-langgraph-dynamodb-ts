import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { BATCH_WRITE_MAX } from '../constants';
import { DrainOptions, drainUnprocessedWrites } from './drain-unprocessed';
import type { WriteRequest } from './types';

/**
 * Write an arbitrary number of requests, chunked into batches of 25 (the
 * BatchWriteItem limit). Each batch drains its UnprocessedItems independently.
 * Partial-success applies across batches — see {@link BatchWriteIncompleteError}.
 */
export async function batchWriteAll(
  client: DynamoDBDocument,
  tableName: string,
  requests: WriteRequest[],
  options: DrainOptions = {},
): Promise<void> {
  for (let offset = 0; offset < requests.length; offset += BATCH_WRITE_MAX) {
    const chunk = requests.slice(offset, offset + BATCH_WRITE_MAX);
    await drainUnprocessedWrites(client, tableName, chunk, options);
  }
}
