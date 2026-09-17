import type { DescriptorRef } from '../../shared/codec/descriptor-keys';
import type { DocItem } from '../../shared/dynamodb/types';
import {
  offloadedKey,
  readRow,
  type RowProbe,
  verdictFor,
  type WriteVerdict,
} from '../../shared/dynamodb/write-verify';
import type { CheckpointMetaItem, CheckpointPayloadItem } from '../types';
import type { CheckpointerContext } from './setup';

/** What reading the rows back established. */
export interface CheckpointVerification {
  verdict: WriteVerdict;
  /**
   * The descriptors the two rows held when read, projected to `location` and
   * `s3Key`; only an offloaded one names an object. Filled only for a
   * `'not-landed'` verdict that read both rows, the one answer that licenses a
   * release, and empty otherwise.
   */
  live: DescriptorRef[];
}

/** How one of the two row reads settled. */
type SettledRow = PromiseSettledResult<DocItem | undefined>;

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
 * What the two settled reads support.
 *
 * The probed row alone decides a landing, and a landing releases nothing, so
 * the other read is not needed for it. A non-commit licenses a release, and the
 * other row may name the very object being released, so that verdict needs both
 * rows; without the other one the answer is `'unverified'`. A failed probed read
 * establishes nothing at all.
 */
function verificationOf(
  probe: RowProbe,
  metaRead: SettledRow,
  payloadRead: SettledRow,
): CheckpointVerification {
  const probed = probe.attribute === 'metadata' ? metaRead : payloadRead;
  if (probed.status === 'rejected') return { verdict: 'unverified', live: [] };
  if (verdictFor(probe, probed.value) === 'landed') return { verdict: 'landed', live: [] };
  if (metaRead.status === 'rejected' || payloadRead.status === 'rejected') {
    return { verdict: 'unverified', live: [] };
  }
  const live = [metaRead.value?.metadata, payloadRead.value?.checkpoint].filter(
    (ref): ref is DescriptorRef => Boolean(ref),
  );
  return { verdict: 'not-landed', live };
}

/**
 * Read both rows back after the META+PAYLOAD transaction failed and report what
 * that failure actually did — never assuming it did nothing.
 *
 * Two reads, issued together, and each needed for a different answer. The rows
 * commit together, so the row carrying an offloaded descriptor proves a landing
 * on its own, even when the other row's read fails: a landing releases nothing.
 * A non-commit is different, because what a cleanup may release is decided by
 * both rows. Another writer that committed the same checkpoint id with identical
 * checkpoint bytes and different metadata holds this attempt's checkpoint key on
 * its PAYLOAD row while its META row proves this attempt did not land, and
 * deleting that key would strand its row (C-02c). A non-commit whose other row
 * could not be read is therefore `'unverified'`. The reads are issued only when
 * something was offloaded, because only then is there an object to protect.
 *
 * Accepts: `meta` and `payload` — the two rows the failed transaction carried.
 * A fully inline write has no object at stake and spends no read.
 *
 * Returns: the verdict — see {@link WriteVerdict} for what each answer licenses
 * the caller to do. `'landed'` when the probed row holds this attempt's key,
 * whatever the other read did; `'not-landed'` when it does not and both reads
 * succeeded, with `live` holding every descriptor the two rows held when read,
 * each projected to its `location` and `s3Key`; `'unverified'` when the probed
 * read failed, or when it disproved the landing and the other read failed.
 * `live` is empty for every answer but `'not-landed'` after two reads.
 *
 * Throws: nothing — a failed read is part of the answer.
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
  const [metaRead, payloadRead] = await Promise.allSettled([
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
  return verificationOf(probe, metaRead, payloadRead);
}
