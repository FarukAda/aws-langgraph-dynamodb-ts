import { type PayloadDescriptor, PayloadLocation } from '../../shared/codec/codec';
import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { StoreItemRecord } from '../types';
import { putWithRevisionSwap } from './overwrite-swap';
import type { ExistingRecordMeta } from './read-existing';
import type { StoreContext } from './setup';
import { verifyWriteLanded, type WriteVerdict } from './write-verify';

/**
 * Best-effort delete of one descriptor's S3 object. `scope` is passed for a
 * descriptor read back from the row (the superseded value) and omitted for
 * this call's own upload.
 */
async function cleanUp(
  context: StoreContext,
  descriptor: PayloadDescriptor | undefined,
  label: string,
  scope?: readonly string[],
): Promise<void> {
  if (!context.offloader || !descriptor) return;
  await cleanUpS3Orphans(
    context.offloader,
    collectS3Keys([descriptor]),
    label,
    context.logger,
    scope === undefined ? {} : { scope },
  );
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
 * Every failure reaching the catch arrives after at least one put was issued —
 * `putWithRevisionSwap` only re-reads from inside its own catch — so none of
 * them proves a non-commit on its own: a put can commit server-side and lose
 * its response, and a `ConditionalCheckFailedException` is as consistent with
 * hitting the row this call just wrote as with a competitor's win. The row is
 * therefore read back (`verifyWriteLanded`) before anything is deleted. Only a
 * confirmed `'not-landed'` deletes this record's own nonced object; a confirmed
 * `'landed'` cleans up the previous object like the success path and swallows
 * the error, and an `'unverified'` read deletes nothing and rethrows — leaking
 * one object at worst rather than stranding a live row pointing at a deleted
 * one. An inline payload has no object to leak, so it needs no read.
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
    const verdict: WriteVerdict =
      record.value.location === PayloadLocation.S3
        ? await verifyWriteLanded(context, record, record.value.s3Key)
        : 'not-landed';
    if (verdict === 'not-landed') await cleanUp(context, record.value, 'store.put');
    if (verdict !== 'landed') throw error;
  }
  await cleanUp(context, superseded.value, 'store.put.overwrite', [
    ...record.namespace,
    record.key,
  ]);
}
