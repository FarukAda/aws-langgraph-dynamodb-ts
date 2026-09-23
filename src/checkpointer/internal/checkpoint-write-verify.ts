import { rowKeyOf } from '../../shared/dynamodb/table-schema';
import {
  offloadedKey,
  type RowProbe,
  verifyRow,
  type WriteVerdict,
} from '../../shared/dynamodb/write-verify';
import type { CheckpointMetaItem, CheckpointPayloadItem } from '../types';
import type { CheckpointerContext } from './setup';

/**
 * Pick the row carrying an offloaded descriptor, projected to that
 * descriptor's `location` and `s3Key`. The META and PAYLOAD rows commit in one
 * transaction, so one of them is enough; with neither offloaded there is
 * nothing to protect and no read to spend, which {@link verifyRow} answers
 * `'not-landed'` for an absent `expected`.
 */
function chooseProbe(meta: CheckpointMetaItem, payload: CheckpointPayloadItem): RowProbe {
  const metaKey = offloadedKey(meta.metadata);
  if (metaKey !== undefined) {
    return {
      key: rowKeyOf(meta),
      kind: 'descriptor',
      attribute: 'metadata',
      expected: metaKey,
      descriptors: ['metadata'],
    };
  }
  return {
    key: rowKeyOf(payload),
    kind: 'descriptor',
    attribute: 'checkpoint',
    expected: offloadedKey(payload.checkpoint),
    descriptors: ['checkpoint'],
  };
}

/**
 * Read one of the two rows back after the META+PAYLOAD transaction failed and
 * report what that failure actually did — never assuming it did nothing.
 *
 * Accepts: `meta` and `payload` — the two rows the failed transaction carried.
 * Whichever of them has something offloaded is the one read back; a fully
 * inline write has no object at stake and spends no read.
 *
 * Returns: the verdict. See {@link WriteVerdict} for what each answer licenses
 * the caller to do. `'landed'` when the row holds this attempt's key,
 * `'not-landed'` when it holds another or none, `'unverified'` when the read
 * failed.
 *
 * Throws: nothing — a failed read is the `'unverified'` answer.
 *
 * Guarantees: both descriptors' keys end in the object id this put drew, which
 * no other put uses. The row holds this attempt's key only if this put's
 * transaction committed, and the other row commits with it, so one read decides
 * the landing. A row holding any other key was committed by another put, whose
 * rows name only that put's objects, so a `'not-landed'` answer leaves both of
 * this put's uploads named by no row.
 */
export async function verifyCheckpointLanded(
  context: CheckpointerContext,
  meta: CheckpointMetaItem,
  payload: CheckpointPayloadItem,
): Promise<WriteVerdict> {
  const { verdict } = await verifyRow(context, chooseProbe(meta, payload));
  return verdict;
}
