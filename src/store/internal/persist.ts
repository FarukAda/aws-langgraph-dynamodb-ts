import { type PayloadDescriptor, PayloadLocation } from '../../shared/codec/codec';
import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { StoreItemRecord } from '../types';
import type { StoreContext } from './setup';
import { isRetryExhausted, writeLandedAt } from './write-verify';

/**
 * Put the record: on a definite failure, clean up *this* record's nonced S3
 * object; on an ambiguous retry-exhaustion failure, verify via
 * `writeLandedAt` before deleting anything — if it landed, clean up the
 * *previous* row's object instead, like the ordinary success path.
 */
export async function persistRecord(
  context: StoreContext,
  record: StoreItemRecord,
  previousValue: PayloadDescriptor | undefined,
): Promise<void> {
  try {
    await withDynamoDBRetry(() =>
      context.client.put({ TableName: context.tableName, Item: record }),
    );
  } catch (error) {
    const landed =
      isRetryExhausted(error as Error) &&
      record.value.location === PayloadLocation.S3 &&
      (await writeLandedAt(context, record, record.value.s3Key));
    if (!landed) {
      if (context.offloader) {
        await cleanUpS3Orphans(
          context.offloader,
          collectS3Keys([record.value]),
          'store.put',
          context.logger,
        );
      }
      throw error;
    }
  }
  if (context.offloader && previousValue) {
    await cleanUpS3Orphans(
      context.offloader,
      collectS3Keys([previousValue]),
      'store.put.overwrite',
      context.logger,
    );
  }
}
