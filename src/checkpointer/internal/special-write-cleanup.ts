import type { PayloadDescriptor } from '../../shared/codec/codec';
import { releasableS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import type { CheckpointWriteItem } from '../types';
import type { CheckpointerContext } from './setup';
import { writeSpecialItem } from './special-write-cas';
import type { SpecialWriteOutcome } from './special-write-verify';

/**
 * A descriptor to release, paired with every descriptor a surviving row may
 * hold; an absent entry in `keep` is ignored.
 */
interface CleanupPair {
  release: PayloadDescriptor | undefined;
  keep: readonly (PayloadDescriptor | undefined)[];
}

/**
 * Best-effort delete the S3 objects behind the `release` side of each pair,
 * skipping any object the matching `keep` side still points at. Two writes of
 * the same value produce the same content-addressed key, whether they are one
 * call overwriting its own value or two racing calls, and deleting it would
 * strand the row that survives (see {@link releasableS3Keys}).
 *
 * `scope` is given for descriptors read back from rows (the superseded values)
 * and omitted for this call's own uploads.
 */
async function deleteDescriptors(
  context: CheckpointerContext,
  pairs: CleanupPair[],
  label: string,
  scope?: readonly string[],
): Promise<void> {
  if (!context.offloader) return;
  const keys = pairs.flatMap(({ release, keep }) =>
    release
      ? releasableS3Keys(
          [release],
          keep.filter((ref): ref is PayloadDescriptor => Boolean(ref)),
        )
      : [],
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
 * Write special (negative-index) items, then clean up the correct side of each.
 *
 * Overwrite is correct here, matching every reference checkpointer. Each item
 * is written with a compare-and-swap on its row's `writeGroup` (see
 * {@link writeSpecialItem}) so a concurrent call to the same special channel
 * cannot make both callers delete the same superseded object and orphan one
 * upload. A committed item cleans up the payload it actually superseded; an
 * item confirmed never to have committed cleans up its own new upload, unless
 * the row that exists names it — a racer that wrote the same value holds this
 * item's key (C-02b).
 *
 * "Confirmed" is load-bearing, and {@link writeSpecialItem} is what earns it:
 * an ambiguous failure, or a first read of the row that failed, is reported as
 * committed unless a read proves otherwise. Deleting on *unknown* would strand
 * a live row pointing at a deleted object; leaking one object instead is
 * recoverable.
 *
 * Accepts: `items` — this call's special-channel rows; empty writes nothing.
 * `threadId` — the caller's, which scopes every object this cleanup may delete.
 *
 * Returns: the first failure, or undefined when every item committed.
 *
 * Throws: nothing — a failure is reported via the return value, because the
 * caller runs this concurrently with `writeRegularItems` under `Promise.all`,
 * whose own cleanup depends on every branch resolving rather than
 * short-circuiting.
 *
 * Guarantees: an object is released only when the row that survives does not
 * point at it — identical bytes produce an identical key, so the loser's "dead"
 * upload is the winner's live object when the two wrote the same value.
 */
export async function writeSpecialItemsWithCleanup(
  context: CheckpointerContext,
  threadId: string,
  items: CheckpointWriteItem[],
  signal?: AbortSignal,
): Promise<Error | undefined> {
  if (items.length === 0) return undefined;
  const outcomes = await Promise.all(
    items.map(async (item): Promise<[CheckpointWriteItem, SpecialWriteOutcome]> => [
      item,
      await writeSpecialItem(context, item, signal),
    ]),
  );
  await deleteDescriptors(
    context,
    outcomes
      .filter(([, o]) => o.committed)
      .map(([item, o]) => ({ release: o.superseded, keep: [item.value] })),
    'putWrites.special.previous',
    [threadId],
  );
  await deleteDescriptors(
    context,
    outcomes
      .filter(([, o]) => !o.committed)
      .map(([item, o]) => ({ release: item.value, keep: [o.live, o.superseded] })),
    'putWrites.special.newUpload',
  );
  return outcomes.find(([, o]) => o.error)?.[1].error;
}
