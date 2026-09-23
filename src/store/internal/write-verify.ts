import { REVISION_ATTRIBUTE } from '../../shared/dynamodb/conditional-put';
import { readRow, verifyRow, type WriteVerdict } from '../../shared/dynamodb/write-verify';
import { hasErrorCode } from '../../shared/errors/base-error';
import { ErrorCode } from '../../shared/errors/error-code';
import type { StoreContext } from './setup';

/**
 * Whether `error` is a spent retry budget.
 *
 * Accepts: any error, and equally anything else a `throw` can produce.
 * Recognised by brand and code: the code is the one thing an error crossing a
 * module or realm boundary can be relied on to keep.
 *
 * Returns: whether the write is ambiguous for the reason retries were spent,
 * which is the only failure a verification read is allowed to resolve.
 *
 * Throws: **nothing**, for any value. A value carrying no such code is not a
 * spent budget, so the caller rethrows it rather than spending a read on it.
 */
export function isRetryExhausted(error: Error): boolean {
  return hasErrorCode(error, ErrorCode.RETRY_EXHAUSTED);
}

/**
 * True when the row is confirmed absent — used to resolve an ambiguous
 * retry-exhausted *delete*, where the delete may well have landed server-side
 * and only its acknowledgement was lost. Only the partition key is projected:
 * existence is the whole question.
 *
 * Accepts: the row's key.
 *
 * Returns: whether the row is confirmed gone. A failed read answers `false` —
 * "not confirmed", never "still there": the caller only rethrows on `false`, so
 * nothing is deleted on the strength of a read that did not happen.
 *
 * Throws: nothing.
 */
export async function rowIsAbsent(
  context: StoreContext,
  key: { PK: string; SK: string },
): Promise<boolean> {
  try {
    const row = await readRow(context, { key, attribute: 'PK' });
    return row === undefined;
  } catch {
    return false;
  }
}

/**
 * Read `record`'s row back to establish what an ambiguous write actually did,
 * comparing the row's revision with the one this write carried. Every put
 * stamps a fresh per-call `rev`, so the comparison works for inline and
 * offloaded records alike.
 *
 * Accepts: `record` — the row this call wrote, carrying the `rev` it stamped.
 * A record with no `rev` has nothing to compare and is reported `'not-landed'`
 * without spending a read.
 *
 * Returns: `'landed'`, `'not-landed'` or `'unverified'`; see
 * {@link WriteVerdict} for what each answer licenses the caller to do. Only the
 * `rev` is read: an offloaded record's key ends in that same `rev`, so the row
 * holding a different one never names this write's object, and a cleanup
 * needs nothing more from it.
 *
 * Throws: nothing — a failed verification is `'unverified'`, which is an
 * answer, not an error.
 */
export async function verifyWriteLanded(
  context: StoreContext,
  record: { PK: string; SK: string; rev?: string },
): Promise<WriteVerdict> {
  const { verdict } = await verifyRow(context, {
    key: { PK: record.PK, SK: record.SK },
    kind: 'attribute',
    attribute: REVISION_ATTRIBUTE,
    expected: record.rev,
  });
  return verdict;
}
