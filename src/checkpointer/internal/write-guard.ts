import { rejectedItem } from '../../shared/dynamodb/conditional-put';
import { truncateForLog } from '../../shared/logging/truncate';
import type { CheckpointWriteItem } from './rows';
import type { CheckpointerContext } from './setup';

/**
 * The channel recorded on the row that turned a write away, or undefined when
 * the service returned no attributes (`ReturnValuesOnConditionCheckFailure:
 * 'ALL_OLD'` attaches the existing item to the exception at no extra round trip).
 */
function rejectedChannel(error: Error): string | undefined {
  return rejectedItem(error)?.channel as string | undefined;
}

/**
 * Report a guard rejection. Sort keys carry their channel, so a rejection
 * normally means this exact (task, channel, occurrence) row is already
 * committed — a genuine duplicate, and the expected outcome of a retry. A row
 * held by a *different* channel is not something this adapter can produce, so
 * it is reported at `warn`: the write was not persisted and something else
 * wrote to this key space.
 *
 * Accepts: `error` — the rejection, which carries the row that caused it when
 * the service returned attributes. No attributes means the two cases cannot be
 * told apart, and the ordinary duplicate is the one assumed: warning on every
 * unattributed rejection would cry wolf on the expected outcome of a retry.
 *
 * Returns: nothing. A rejection is not a failure here — first-write-wins means
 * losing is a normal outcome — so it is reported, not thrown.
 *
 * Throws: nothing.
 */
export function reportGuardRejection(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
  error: Error,
): void {
  const found = rejectedChannel(error);
  if (found !== undefined && found !== item.channel) {
    context.logger.warn('putWrites: write row held by an unexpected channel; write not persisted', {
      sortKey: item.SK,
      expected: item.channel,
      found: truncateForLog(found),
    });
    return;
  }
  context.logger.debug('putWrites: skipped a write already committed for this task and channel', {
    sortKey: item.SK,
    channel: item.channel,
  });
}

/**
 * Whether the rejection's returned row provably belongs to another `putWrites`
 * call.
 *
 * Accepts: `error` — the rejection. `item` — the row this call tried to write,
 * carrying its own `writeGroup`.
 *
 * Returns: whether the row that won carries a *different* group, which is the
 * only evidence that this call's own upload is dead and safe to delete. A
 * retried put whose response was lost can be rejected by the row it wrote
 * itself, so an equal group — or no attributes at all — proves nothing and is
 * answered `false`: the object is then left to the lifecycle rule rather than
 * deleted out from under a live row.
 *
 * Throws: nothing.
 */
export function rejectionProvesForeignRow(item: CheckpointWriteItem, error: Error): boolean {
  const group = rejectedItem(error)?.writeGroup as string | undefined;
  return group !== undefined && group !== item.writeGroup;
}
