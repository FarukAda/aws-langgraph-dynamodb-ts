import type { PendingWrite, PendingWriteValue } from '@langchain/langgraph-checkpoint';
import { WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint';

/** One write with its sort-key index resolved exactly once. */
export interface ResolvedWrite {
  channel: string;
  value: PendingWriteValue;
  index: number;
}

/**
 * Assign every write in one `putWrites` call its sort-key index, in a single
 * pass — nothing recomputes it downstream, which is what used to let the
 * deduped array's positions disagree with the ones the caller's array
 * produced.
 *
 * A regular write's index is its position in the caller's array, exactly as
 * the reference `MemorySaver` computes it: that is what makes stored writes
 * replay in the order the task emitted them. A special channel takes its
 * fixed `WRITES_IDX_MAP` slot instead, and a later duplicate replaces an
 * earlier one (last-write-wins, again matching the reference).
 *
 * Positions are not stable across calls, which is why the *sort key* also
 * carries the channel and each call stamps its rows with a shared
 * `writeGroup` — see {@link buildWriteItems} and `dropSupersededWrites`.
 *
 * `Object.hasOwn` guards WRITES_IDX_MAP's own `Object.prototype` chain — a
 * channel literally named `constructor`/`toString`/etc. must be treated as
 * regular, not resolve to an inherited function reference.
 */
export function resolveWriteIndices(writes: PendingWrite[]): ResolvedWrite[] {
  const bySpecialIndex = new Map<number, ResolvedWrite>();
  const regular: ResolvedWrite[] = [];
  writes.forEach(([channel, value], positional) => {
    if (Object.hasOwn(WRITES_IDX_MAP, channel)) {
      const index = WRITES_IDX_MAP[channel];
      bySpecialIndex.set(index, { channel, value, index });
      return;
    }
    regular.push({ channel, value, index: positional });
  });
  return [...bySpecialIndex.values(), ...regular];
}
