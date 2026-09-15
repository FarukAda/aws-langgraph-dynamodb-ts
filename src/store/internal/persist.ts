import { type DescriptorRef, releasableS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { WriteVerdict } from '../../shared/dynamodb/write-verify';
import type { StoreItemRecord } from '../types';
import { putWithRevisionSwap } from './overwrite-swap';
import type { ExistingRecordMeta } from './read-existing';
import type { StoreContext } from './setup';
import { verifyWriteLanded } from './write-verify';

/**
 * Best-effort delete of the S3 object behind `release`, unless `keep` — the
 * descriptor of whichever row survives this call — points at the same object.
 * See {@link releasableS3Keys}: identical bytes produce an identical key, so
 * the two sides of an overwrite can name one object.
 *
 * `scope` is passed for a descriptor read back from the row (the superseded
 * value) and omitted for this call's own upload.
 */
async function cleanUp(
  context: StoreContext,
  release: DescriptorRef | undefined,
  keep: DescriptorRef | undefined,
  label: string,
  scope?: readonly string[],
): Promise<void> {
  if (!context.offloader || !release) return;
  const keys = releasableS3Keys([release], keep ? [keep] : []);
  if (keys.length === 0) return;
  await cleanUpS3Orphans(
    context.offloader,
    keys,
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
 * Guarantees: no object is deleted while a live row still points at it. The
 * failure modes are ordered by which is worse: a leaked object costs storage
 * until the lifecycle rule reclaims it, while a row pointing at a deleted
 * object is unreadable data, so every ambiguous case leaks instead of deletes.
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
        () => context.client.put({ TableName: context.tableName, Item: record }),
        context.retry,
      );
    }
  } catch (error) {
    const verdict: WriteVerdict = await verifyWriteLanded(context, record);
    if (verdict === 'not-landed') await cleanUp(context, record.value, existing.value, 'store.put');
    if (verdict !== 'landed') throw error;
  }
  await cleanUp(context, superseded.value, record.value, 'store.put.overwrite', [
    ...record.namespace,
    record.key,
  ]);
}
