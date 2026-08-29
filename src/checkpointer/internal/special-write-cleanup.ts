import type { PayloadDescriptor } from '../../shared/codec/codec';
import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import type { CheckpointWriteItem } from '../types';
import type { CheckpointerContext } from './setup';
import { writeSpecialItem } from './special-write-cas';
import type { SpecialWriteOutcome } from './special-write-verify';

/** Best-effort delete the S3 objects backing `descriptors`, if offloading is on. */
async function deleteDescriptors(
  context: CheckpointerContext,
  descriptors: (PayloadDescriptor | undefined)[],
  label: string,
): Promise<void> {
  if (!context.offloader) return;
  const present = descriptors.filter((d): d is PayloadDescriptor => d !== undefined);
  if (present.length === 0) return;
  await cleanUpS3Orphans(context.offloader, collectS3Keys(present), label, context.logger);
}

/**
 * Write special (negative-index) items, then clean up the correct side of each.
 *
 * Overwrite is correct here, matching every reference checkpointer. Each item
 * is written with a compare-and-swap on its row's `writeGroup` (see
 * {@link writeSpecialItem}) so a concurrent call to the same special channel
 * cannot make both callers delete the same superseded object and orphan one
 * upload. A committed item cleans up the payload it actually superseded; an
 * item confirmed never to have committed cleans up its own new upload.
 *
 * "Confirmed" is load-bearing, and {@link writeSpecialItem} is what earns it:
 * an ambiguous failure is verified against the row and reported as committed
 * unless the read proves otherwise. Deleting on *unknown* would strand a live
 * row pointing at a deleted object; leaking one object instead is recoverable.
 *
 * Never rejects — a failure is reported via the return value, because the
 * caller runs this concurrently with `writeRegularItems` under `Promise.all`,
 * whose own cleanup depends on every branch resolving rather than
 * short-circuiting.
 */
export async function writeSpecialItemsWithCleanup(
  context: CheckpointerContext,
  items: CheckpointWriteItem[],
): Promise<Error | undefined> {
  if (items.length === 0) return undefined;
  const outcomes = await Promise.all(
    items.map(async (item): Promise<[CheckpointWriteItem, SpecialWriteOutcome]> => [
      item,
      await writeSpecialItem(context, item),
    ]),
  );
  await deleteDescriptors(
    context,
    outcomes.filter(([, o]) => o.committed).map(([, o]) => o.superseded),
    'putWrites.special.previous',
  );
  await deleteDescriptors(
    context,
    outcomes.filter(([, o]) => !o.committed).map(([item]) => item.value),
    'putWrites.special.newUpload',
  );
  return outcomes.find(([, o]) => o.error)?.[1].error;
}
