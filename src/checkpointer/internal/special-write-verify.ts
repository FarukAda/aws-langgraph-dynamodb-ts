import type { PayloadDescriptor } from '../../shared/codec/codec';
import { isConditionalCheckFailed, rejectedItem } from '../../shared/dynamodb/conditional-put';
import type { DocItem } from '../../shared/dynamodb/types';
import { readRow, type RowProbe, verdictFor, verifyRow } from '../../shared/dynamodb/write-verify';
import type { CheckpointWriteItem } from '../types';
import type { CheckpointerContext } from './setup';

/**
 * A special row already carries a per-call ULID in `writeGroup`, so it needs no
 * extra revision attribute to compare and swap on.
 */
export const SPECIAL_REVISION_ATTRIBUTE = 'writeGroup';

/** What a special item's row held before this call tried to overwrite it. */
export interface SpecialRowState {
  exists: boolean;
  value?: PayloadDescriptor;
  revision?: string;
}

/** Outcome of one special item's conditional write. Never thrown, always returned. */
export interface SpecialWriteOutcome {
  committed: boolean;
  superseded?: PayloadDescriptor;
  error?: Error;
}

/** What a post-failure verification read established about the attempt. */
export interface VerifiedFailure {
  outcome: SpecialWriteOutcome;
  /** Present only when the row was read and holds some other writer's group. */
  observed?: SpecialRowState;
}

/**
 * The probe that recognises `item`'s own write on its row.
 *
 * Accepts: `item` — the row this call tried to write, carrying its own
 * `writeGroup`.
 *
 * Returns: the probe, which projects the guard attribute and the descriptor —
 * the descriptor because a caller that has to re-pin a compare-and-swap needs
 * the value it lost to, not just the fact that it lost.
 *
 * Throws: nothing.
 */
export function specialRowProbe(item: CheckpointWriteItem): RowProbe {
  return {
    key: { PK: item.PK, SK: item.SK },
    kind: 'attribute',
    attribute: SPECIAL_REVISION_ATTRIBUTE,
    expected: item.writeGroup,
    also: ['value'],
  };
}

/** A read row, in the shape the compare-and-swap pins its next attempt to. */
function stateOf(row: DocItem | undefined): SpecialRowState {
  if (!row) return { exists: false };
  return {
    exists: true,
    value: row.value as PayloadDescriptor | undefined,
    revision: row[SPECIAL_REVISION_ATTRIBUTE] as string | undefined,
  };
}

/**
 * Read a special row's current descriptor and the writeGroup guarding it.
 *
 * Accepts: `item` — the row to read, by its key.
 *
 * Returns: the row's state, with `exists: false` when there is none — which is
 * what a first writer pins its compare-and-swap to.
 *
 * Throws: whatever the read throws. Deliberately not swallowed: the caller
 * reports that failure with its own cause rather than guessing at the row's
 * state, which is why this is separate from {@link verifyAfterFailure}.
 */
export async function readSpecialRow(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
): Promise<SpecialRowState> {
  return stateOf(await readRow(context, specialRowProbe(item)));
}

/**
 * Read the row back after a put failed, and report what that failure actually
 * did — never assuming it did nothing.
 *
 * A guard rejection already carries the row that turned it away (see
 * `rejectedItem`), so the strongly-consistent read is spent only for a failure
 * that does not: a lost response, or a rejection whose row vanished since.
 *
 * Three answers are possible:
 * - the row holds this item's own `writeGroup`: the write landed, and the
 *   descriptor this attempt pinned is the dead one.
 * - the row holds some other group: the write is confirmed not to be what is
 *   live, so this item's own upload is the dead one. `observed` is returned so
 *   a rejected compare-and-swap can re-pin and try again.
 * - the read itself fails: nothing is confirmed, so the outcome still reports a
 *   commit and keeps the originating error. That leaks one S3 object at worst
 *   (reclaimed by `ensureS3LifecycleRule`) where the alternative strands a live
 *   row — the same trade `store/internal/persist.ts` makes.
 *
 * Accepts: `attempted` — the state this attempt pinned, whose descriptor is the
 * one superseded if the write did land. `error` — the failure being explained.
 *
 * Returns: the outcome, and the row's observed state when another writer holds
 * it, so a rejected compare-and-swap can re-pin and try again.
 *
 * Throws: nothing. It exists to turn a failure into a decision.
 *
 * Guarantees: a guard rejection already carries the row that turned it away, so
 * the strongly-consistent read is spent only for a failure that does not — a
 * lost response, or a rejection whose row vanished since.
 */
export async function verifyAfterFailure(
  context: CheckpointerContext,
  item: CheckpointWriteItem,
  attempted: SpecialRowState,
  error: Error,
): Promise<VerifiedFailure> {
  const probe = specialRowProbe(item);
  const rejected = isConditionalCheckFailed(error) ? rejectedItem(error) : undefined;
  const { verdict, row } = rejected
    ? { verdict: verdictFor(probe, rejected), row: rejected }
    : await verifyRow(context, probe);
  if (verdict === 'landed') return { outcome: { committed: true, superseded: attempted.value } };
  if (verdict === 'unverified') return { outcome: { committed: true, error } };
  return { outcome: { committed: false, error }, observed: stateOf(row) };
}
