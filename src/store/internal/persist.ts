import { type PayloadDescriptor, PayloadLocation } from '../../shared/codec/codec';
import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { StoreItemRecord } from '../types';
import { putWithRevisionSwap } from './overwrite-swap';
import type { ExistingRecordMeta } from './read-existing';
import type { StoreContext } from './setup';
import { isRetryExhausted, writeLandedAt } from './write-verify';

/** Best-effort delete of one descriptor's S3 object. */
async function cleanUp(
  context: StoreContext,
  descriptor: PayloadDescriptor | undefined,
  label: string,
): Promise<void> {
  if (!context.offloader || !descriptor) return;
  await cleanUpS3Orphans(context.offloader, collectS3Keys([descriptor]), label, context.logger);
}

/**
 * Put the record and clean up whichever side is now dead.
 *
 * The compare-and-swap path runs **only when an offloader is configured**:
 * without one there is no S3 object to orphan, so a plain last-write-wins put
 * stays correct and costs no extra write capacity (DynamoDB charges for a
 * failed conditional write too). With one, the swap is what lets this call
 * delete exactly the payload it superseded rather than a descriptor a racer may
 * already have replaced.
 *
 * On a definite failure this cleans up *this* record's own nonced object; on an
 * ambiguous retry-exhaustion it verifies via `writeLandedAt` first, and if the
 * write did land it cleans up the previous object like the success path.
 */
export async function persistRecord(
  context: StoreContext,
  record: StoreItemRecord,
  existing: ExistingRecordMeta,
): Promise<void> {
  let superseded = existing;
  try {
    if (context.offloader) {
      superseded = await putWithRevisionSwap(context, record, existing);
    } else {
      await withDynamoDBRetry(() =>
        context.client.put({ TableName: context.tableName, Item: record }),
      );
    }
  } catch (error) {
    const landed =
      isRetryExhausted(error as Error) &&
      record.value.location === PayloadLocation.S3 &&
      (await writeLandedAt(context, record, record.value.s3Key));
    if (!landed) {
      await cleanUp(context, record.value, 'store.put');
      throw error;
    }
  }
  await cleanUp(context, superseded.value, 'store.put.overwrite');
}
