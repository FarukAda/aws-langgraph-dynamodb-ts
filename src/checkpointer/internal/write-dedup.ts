import type { CheckpointWriteItem } from '../types';

/**
 * Resolve a task's pending writes to one row per `(taskId, channel,
 * occurrence)`, keeping the earliest `putWrites` call that wrote it.
 *
 * A regular write's index is its position in the caller's array, so a retried
 * task whose write mix changed places an already-committed channel at a
 * different index, where the first-write-wins guard cannot recognise it and a
 * second row commits. Replaying both double-counts an accumulating channel.
 * Each call stamps its rows with one `writeGroup`, and the earliest group per
 * identity is the call that actually won.
 *
 * `occurrence` is part of the identity so a retry that legitimately emits a
 * channel *more* often than the original keeps both values, which is what
 * `MemorySaver` does when it keys first-write-wins on `(taskId, index)`.
 *
 * Accepts: `items` — the WRITE rows of one checkpoint, in any order; empty is
 * empty. A row written before `writeGroup` or `occurrence` existed carries
 * neither, and both are normalised at the edge rather than tested for.
 *
 * Returns: the rows to replay, in the order given. One per `(taskId, channel,
 * occurrence)`: the row whose `writeGroup` sorts earliest, which is the call
 * that actually won the first-write-wins guard.
 *
 * Throws: nothing.
 *
 * Guarantees: exactly one row survives per identity. Two rows could tie only by
 * sharing a `writeGroup` as well, and one call assigns each of its channels a
 * distinct `occurrence`, so within a call the identity is already unique.
 */
export function dropSupersededWrites(items: CheckpointWriteItem[]): CheckpointWriteItem[] {
  const identity = (item: CheckpointWriteItem): string =>
    JSON.stringify([item.taskId, item.channel, item.occurrence ?? 0]);
  /**
   * The call a row belongs to, as something orderable. A row written before
   * `writeGroup` existed carries none and is older than every row that does —
   * the empty string sorts before any ULID.
   *
   * Keeping the raw `undefined` reversed first-write-wins across an upgrade: a
   * `Map` cannot tell a key whose value is absent from one whose value *is*
   * `undefined`, so the guard that checks "nothing recorded yet" fired again on
   * the pre-upgrade row's own entry and let the next, newer row overwrite it.
   * Normalising at the edge removes the ambiguity instead of testing for it.
   */
  const groupOf = (item: CheckpointWriteItem): string => item.writeGroup ?? '';
  const earliestGroup = new Map<string, string>();
  for (const item of items) {
    const id = identity(item);
    const seen = earliestGroup.get(id);
    const group = groupOf(item);
    if (seen === undefined || group < seen) earliestGroup.set(id, group);
  }
  return items.filter((item) => earliestGroup.get(identity(item)) === groupOf(item));
}
