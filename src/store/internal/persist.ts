import { collectS3Keys, type DescriptorRef } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { StoreItemRecord } from '../types';
import { putWithRevisionSwap } from './overwrite-swap';
import type { ExistingRecordMeta } from './read-existing';
import type { StoreContext } from './setup';
import { verifyWriteLanded } from './write-verify';

/**
 * Best-effort delete of the S3 object behind `release`, if it names one.
 *
 * `release` is absent when there is nothing to release, and a row this library
 * did not write can hold `null` there, so it is tested for truthiness. `scope`
 * is passed for a descriptor read back from the row (the superseded value) and
 * omitted for this call's own upload.
 */
async function cleanUp(
  context: StoreContext,
  release: DescriptorRef | undefined,
  label: string,
  scope?: readonly string[],
): Promise<void> {
  if (!context.offloader || !release) return;
  await cleanUpS3Orphans(
    context.offloader,
    collectS3Keys([release]),
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
 * confirmed `'not-landed'` deletes this record's own object; a confirmed
 * `'landed'` cleans up the previous object like the success path and swallows
 * the error, and an `'unverified'` read deletes nothing and rethrows — leaking
 * one object at worst rather than stranding a live row pointing at a deleted
 * one. The verification compares the per-call `rev`, so an inline record is
 * verified too: a lost acknowledgement of an inline overwrite used to be
 * reported as a failure while the previous offloaded object was never cleaned.
 *
 * Neither release reads the row again first. The record's object is uploaded
 * under the record's own `rev`, which no other put uses, so no row another put
 * commits names it; and the record names only that object, never the one it
 * superseded.
 *
 * Accepts: `record` — the fully encoded row, its payload already uploaded if it
 * was offloaded. `existing` — what the caller read before encoding.
 *
 * Returns: nothing. The row is committed and exactly one side's object, at
 * most, has been released.
 *
 * Throws: whatever the write throws, unless the verification proves the write
 * landed after all — in which case the error is swallowed and the cleanup runs
 * as on the success path.
 *
 * Guarantees: this record's own object is released only after a read proves
 * the write did not land, and a superseded object only after this record is
 * committed. The failure modes are ordered by which is worse: a leaked object
 * costs storage until the lifecycle rule reclaims it, while a row pointing at a
 * deleted object is unreadable data, so every ambiguous case leaks instead of
 * deletes.
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
      await withDynamoDBRetry(
        (request) => context.client.put({ TableName: context.tableName, Item: record }, request),
        context.retry,
      );
    }
  } catch (error) {
    const verdict = await verifyWriteLanded(context, record);
    if (verdict === 'not-landed') await cleanUp(context, record.value, 'store.put');
    if (verdict !== 'landed') throw error;
  }
  await cleanUp(context, superseded.value, 'store.put.overwrite', [
    ...record.namespace,
    record.key,
  ]);
}
