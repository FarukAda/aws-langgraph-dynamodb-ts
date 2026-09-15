import {
  offloadedKey,
  type RowProbe,
  verifyRow,
  type WriteVerdict,
} from '../../shared/dynamodb/write-verify';
import type { CheckpointMetaItem, CheckpointPayloadItem } from '../types';
import type { CheckpointerContext } from './setup';

/**
 * Pick the row carrying an offloaded descriptor. The META and PAYLOAD rows
 * commit in one transaction, so one of them is enough; with neither offloaded
 * there is nothing to protect and no read to spend, which {@link verifyRow}
 * answers `'not-landed'` for an absent `expected`.
 */
function chooseProbe(meta: CheckpointMetaItem, payload: CheckpointPayloadItem): RowProbe {
  const metaKey = offloadedKey(meta.metadata);
  if (metaKey !== undefined) {
    return {
      key: { PK: meta.PK, SK: meta.SK },
      kind: 'descriptor',
      attribute: 'metadata',
      expected: metaKey,
    };
  }
  return {
    key: { PK: payload.PK, SK: payload.SK },
    kind: 'descriptor',
    attribute: 'checkpoint',
    expected: offloadedKey(payload.checkpoint),
  };
}

/**
 * Read one of the two rows back after the META+PAYLOAD transaction failed and
 * report what that failure actually did — never assuming it did nothing.
 *
 * A key is the content hash of the payload under its row's path, so "the row
 * holds this attempt's key" means the row holds exactly the bytes this attempt
 * intended — whether this attempt or an identical earlier one put them there.
 * Either way the write is live and nothing may be deleted.
 *
 * Accepts: `meta` and `payload` — the two rows the failed transaction carried.
 * Whichever of them has something offloaded is the one read back; a fully
 * inline write has no object at stake and needs no read.
 *
 * Returns: the verdict. See {@link WriteVerdict} for what each answer licenses
 * the caller to do.
 *
 * Throws: nothing — a failed read is the `'unverified'` answer.
 *
 * Guarantees: a key is the content hash of the payload under its row's path, so
 * "the row holds this attempt's key" means the row holds exactly the bytes this
 * attempt intended, whether this attempt or an identical earlier one put them
 * there. Either way the write is live and nothing may be deleted.
 */
export async function verifyCheckpointLanded(
  context: CheckpointerContext,
  meta: CheckpointMetaItem,
  payload: CheckpointPayloadItem,
): Promise<WriteVerdict> {
  const { verdict } = await verifyRow(context, chooseProbe(meta, payload));
  return verdict;
}
