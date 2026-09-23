import type { PayloadDescriptor } from '../../shared/codec/codec';
import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import type { CheckpointWriteItem } from '../types';
import type { ThreadId } from './parse';
import type { CheckpointerContext } from './setup';
import { writeSpecialItem } from './special-write-cas';
import type { SpecialWriteOutcome } from './special-write-verify';

/**
 * Best-effort delete the S3 objects backing `descriptors`, if offloading is on.
 * An absent entry is skipped, and so is a `null` one, which a row this library
 * did not write can hold. `scope` is given for descriptors read back from rows
 * (the superseded values) and omitted for this call's own uploads.
 */
async function deleteDescriptors(
  context: CheckpointerContext,
  descriptors: (PayloadDescriptor | undefined)[],
  label: string,
  scope?: readonly string[],
): Promise<void> {
  if (!context.offloader) return;
  await cleanUpS3Orphans(
    context.offloader,
    collectS3Keys(descriptors.filter((ref): ref is PayloadDescriptor => Boolean(ref))),
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
 * upload. A committed item cleans up the payload it actually superseded, and an
 * item confirmed never to have committed cleans up its own new upload. Neither
 * reads the row again first: every call uploads under its own `writeGroup`, so
 * a row another call writes never names this item's upload, and this item's
 * row names only that upload, never the payload it superseded.
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
 * Guarantees: a superseded payload is released only once the item that
 * superseded it committed, and an item's own upload only once a read, or the
 * row returned with its rejected write, shows the row holding another call's
 * write or no row at all.
 */
export async function writeSpecialItemsWithCleanup(
  context: CheckpointerContext,
  threadId: ThreadId,
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
    outcomes.filter(([, o]) => o.committed).map(([, o]) => o.superseded),
    'putWrites.special.previous',
    [threadId],
  );
  await deleteDescriptors(
    context,
    outcomes.filter(([, o]) => !o.committed).map(([item]) => item.value),
    'putWrites.special.newUpload',
  );
  return outcomes.find(([, o]) => o.error)?.[1].error;
}
