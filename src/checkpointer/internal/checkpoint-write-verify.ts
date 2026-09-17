import type { DescriptorRef } from '../../shared/codec/descriptor-keys';
import {
  offloadedKey,
  readRow,
  type RowProbe,
  verdictFor,
  type WriteVerdict,
} from '../../shared/dynamodb/write-verify';
import type { CheckpointMetaItem, CheckpointPayloadItem } from '../types';
import type { CheckpointerContext } from './setup';

/** What reading both rows back established. */
export interface CheckpointVerification {
  verdict: WriteVerdict;
  /**
   * The descriptors the two rows hold now, projected to `location` and `s3Key`;
   * only an offloaded one names an object. Empty unless both rows were read.
   */
  live: DescriptorRef[];
}

/**
 * Pick the row carrying an offloaded descriptor. The META and PAYLOAD rows
 * commit in one transaction, so one of them is enough to decide the verdict;
 * with neither offloaded there is nothing to protect and no read to spend.
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
 * Read both rows back after the META+PAYLOAD transaction failed and report what
 * that failure actually did — never assuming it did nothing.
 *
 * Two reads, not one. The rows commit together, so the row carrying an
 * offloaded descriptor decides the verdict alone; but what a cleanup may
 * release is decided by both. Another writer that committed the same
 * checkpoint id with identical checkpoint bytes and different metadata holds
 * this attempt's checkpoint key on its PAYLOAD row while its META row proves
 * this attempt did not land, and deleting that key would strand its row
 * (C-02c). The reads are issued only when something was offloaded, because
 * only then is there an object to protect.
 *
 * Accepts: `meta` and `payload` — the two rows the failed transaction carried.
 * A fully inline write has no object at stake and spends no read.
 *
 * Returns: the verdict — see {@link WriteVerdict} for what each answer licenses
 * the caller to do — and `live`, every descriptor the two rows hold now, each
 * projected to its `location` and `s3Key`. `live` is empty when nothing was
 * read, and when either read failed, which is the `'unverified'` answer.
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
): Promise<CheckpointVerification> {
  const probe = chooseProbe(meta, payload);
  if (probe.expected === undefined) return { verdict: 'not-landed', live: [] };
  try {
    const [metaRow, payloadRow] = await Promise.all([
      readRow(context, {
        key: { PK: meta.PK, SK: meta.SK },
        attribute: 'metadata',
        descriptors: ['metadata'],
      }),
      readRow(context, {
        key: { PK: payload.PK, SK: payload.SK },
        attribute: 'checkpoint',
        descriptors: ['checkpoint'],
      }),
    ]);
    const row = probe.attribute === 'metadata' ? metaRow : payloadRow;
    const live = [metaRow?.metadata, payloadRow?.checkpoint].filter((ref): ref is DescriptorRef =>
      Boolean(ref),
    );
    return { verdict: verdictFor(probe, row), live };
  } catch {
    return { verdict: 'unverified', live: [] };
  }
}
