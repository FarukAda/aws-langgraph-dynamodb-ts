import { type DescriptorRef, releasableS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { StoreItemRecord } from '../types';
import { putWithRevisionSwap } from './overwrite-swap';
import type { ExistingRecordMeta } from './read-existing';
import type { StoreContext } from './setup';
import { readLiveValue, verifyWriteLanded } from './write-verify';

/**
 * Best-effort delete of the S3 object behind `release`, unless something in
 * `keep` points at the same object. See {@link releasableS3Keys}: identical
 * bytes produce an identical key, so the two sides of an overwrite, or two
 * racing writers, can name one object.
 *
 * `keep` lists every descriptor a surviving row may hold; an absent entry is
 * ignored. `scope` is passed for a descriptor read back from the row (the
 * superseded value) and omitted for this call's own upload.
 */
async function cleanUp(
  context: StoreContext,
  release: DescriptorRef,
  keep: readonly (DescriptorRef | undefined)[],
  label: string,
  scope?: readonly string[],
): Promise<void> {
  if (!context.offloader) return;
  const keys = releasableS3Keys(
    [release],
    keep.filter((ref): ref is DescriptorRef => Boolean(ref)),
  );
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
 * Release the payload this put superseded, unless the row read just before the
 * release names it.
 *
 * A racer that re-commits the superseded content after this call's swap holds
 * the superseded key, so the row is read before anything goes. The read is
 * spent only when there is something to release, and a read that fails
 * releases nothing.
 */
async function releaseSuperseded(
  context: StoreContext,
  record: StoreItemRecord,
  superseded: ExistingRecordMeta,
): Promise<void> {
  if (!context.offloader || !superseded.value) return;
  if (releasableS3Keys([superseded.value], [record.value]).length === 0) return;
  const live = await readLiveValue(context, { PK: record.PK, SK: record.SK });
  if (live === undefined) {
    context.logger.debug(
      'store.put: the row could not be read back; the superseded object is left to the lifecycle rule',
      { namespace: record.namespace, key: record.key },
    );
    return;
  }
  await cleanUp(context, superseded.value, [record.value, live.value], 'store.put.overwrite', [
    ...record.namespace,
    record.key,
  ]);
}

/**
 * Put the record and clean up whichever side is now dead.
 *
 * The compare-and-swap path runs **only when an offloader is configured**:
 * without one there is no S3 object to orphan, so a plain last-write-wins put
 * stays correct and costs no extra write capacity (DynamoDB charges for a
 * failed conditional write too). With one, the swap is what lets this call
 * delete exactly the payload it superseded rather than a descriptor a racer may
 * already have replaced. The swap proves which payload was superseded, not
 * that no racer has committed those same bytes since, so the row is read again
 * before that payload is released (`releaseSuperseded`).
 *
 * Every failure reaching the catch arrives after at least one put was issued —
 * `putWithRevisionSwap` only re-reads from inside its own catch — so none of
 * them proves a non-commit on its own: a put can commit server-side and lose
 * its response, and a `ConditionalCheckFailedException` is as consistent with
 * hitting the row this call just wrote as with a competitor's win. The row is
 * therefore read back (`verifyWriteLanded`) before anything is deleted. Only a
 * confirmed `'not-landed'` deletes this record's own object, and only when
 * neither the row read back nor the one read before the write names it: a
 * racer that stored identical bytes holds this call's very key, which the
 * pre-write snapshot cannot know (C-02a). A confirmed `'landed'` cleans up the
 * previous object like the success path and swallows the error, and an
 * `'unverified'` read deletes nothing and rethrows — leaking one object at
 * worst rather than stranding a live row pointing at a deleted one. The
 * verification compares the per-call `rev`, so an inline record is verified
 * too: a lost acknowledgement of an inline overwrite used to be reported as a
 * failure while the previous offloaded object was never cleaned.
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
 * Guarantees: an object is released only when the row read immediately before
 * the release does not name it, after a commit and after a failure alike. S3
 * has no conditional delete, so a write of byte-identical content that commits
 * between that read and the delete can still lose its object; that gap is the
 * one remaining window. The failure modes are ordered by which is worse: a
 * leaked object costs storage until the lifecycle rule reclaims it, while a row
 * pointing at a deleted object is unreadable data, so every ambiguous case
 * leaks instead of deletes.
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
    const { verdict, row } = await verifyWriteLanded(context, record);
    /**
     * The row that exists now decides what may go: a racer that stored identical
     * bytes holds this call's key, and the pre-write snapshot cannot know it.
     */
    if (verdict === 'not-landed') {
      await cleanUp(
        context,
        record.value,
        [row?.value as DescriptorRef | undefined, existing.value],
        'store.put',
      );
    }
    if (verdict !== 'landed') throw error;
  }
  await releaseSuperseded(context, record, superseded);
}
