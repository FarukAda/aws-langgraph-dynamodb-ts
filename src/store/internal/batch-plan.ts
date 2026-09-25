/**
 * Hides how a batch runs concurrently and still in the order it was written.
 *
 * Operations on different items, and reads of the same item, share a run and
 * go in flight together; anything that could observe or overwrite an earlier
 * operation's effect starts the next run. A caller sees the order it wrote —
 * a `get` after a `put` of the same item sees it, a `search` sees every write
 * before it — and how independence is judged can change without the store.
 */

import { DEFAULT_READ_CONCURRENCY, mapWithConcurrency } from '../../shared/concurrency';
import type { ParsedOperation, StoreAddress } from './parse';

/** What one operation touches, which is what decides whether it may run beside another. */
type Touch =
  | { readonly kind: 'write'; readonly item: string }
  | { readonly kind: 'get'; readonly item: string }
  // A search or a namespace listing observes every item, so it is scoped to none.
  | { readonly kind: 'broad' };

/** The items a run of mutually independent operations has already claimed. */
interface Segment {
  readonly indices: number[];
  readonly written: Set<string>;
  readonly read: Set<string>;
  hasWrite: boolean;
  hasBroad: boolean;
}

function itemOf(address: StoreAddress): string {
  return JSON.stringify([address.namespace, address.key]);
}

/** What `op` touches, decided by the kind the parser already assigned — the only place that asks. */
function touchOf(op: ParsedOperation): Touch {
  switch (op.kind) {
    case 'put':
    case 'delete':
      return { kind: 'write', item: itemOf(op.address) };
    case 'get':
      return { kind: 'get', item: itemOf(op.address) };
    default:
      return { kind: 'broad' };
  }
}

/**
 * True when `touch` may not join `segment` — because some operation already in
 * it addresses the same item, or because a write and a whole-store read would
 * then be unordered with respect to each other.
 */
function conflicts(segment: Segment, touch: Touch): boolean {
  if (touch.kind === 'broad') return segment.hasWrite;
  if (touch.kind === 'get') return segment.written.has(touch.item);
  return segment.written.has(touch.item) || segment.read.has(touch.item) || segment.hasBroad;
}

function admit(segment: Segment, index: number, touch: Touch): void {
  segment.indices.push(index);
  if (touch.kind === 'broad') segment.hasBroad = true;
  if (touch.kind === 'get') segment.read.add(touch.item);
  if (touch.kind === 'write') {
    segment.written.add(touch.item);
    segment.hasWrite = true;
  }
}

function emptySegment(): Segment {
  return { indices: [], written: new Set(), read: new Set(), hasWrite: false, hasBroad: false };
}

/**
 * Split a batch into runs of mutually independent operations, in caller order.
 *
 * Operations that address different items, and reads that address the same
 * item, are independent of each other and share a run. Anything that could
 * observe or overwrite an earlier operation's effect starts a new one, so the
 * order the caller wrote is the order the caller observes: a `get` after a
 * `put` of the same item sees it, a `get` before one does not, and a `search`
 * sees every write that precedes it and none that follow.
 *
 * Running every write before every read — the earlier behaviour — made a
 * `[delete, get]` batch return nothing where the reference store returns the
 * value, and a `[get, put]` batch return the new value where the reference
 * returns null. `AsyncBatchedStore` coalesces everything enqueued in one tick
 * into a single `batch()`, so that difference is reachable from ordinary code.
 */
function planBatch(operations: readonly ParsedOperation[]): number[][] {
  const runs: number[][] = [];
  let segment = emptySegment();
  operations.forEach((op, index) => {
    const touch = touchOf(op);
    if (segment.indices.length > 0 && conflicts(segment, touch)) {
      runs.push(segment.indices);
      segment = emptySegment();
    }
    admit(segment, index, touch);
  });
  if (segment.indices.length > 0) runs.push(segment.indices);
  return runs;
}

/**
 * Run a batch: each run of independent operations concurrently, at most
 * `limit` in flight, and the runs themselves in
 * order. Results come back in operation order.
 *
 * Accepts: `operations` — in caller order, which is the order they are
 * observed in; empty returns empty. `limit` — operations in flight within one
 * run.
 *
 * Returns: the results in operation order, not completion order.
 *
 * Throws: the first failure. Any failure rejects the whole batch: no operation
 * in a later run starts, the ones already in flight settle, and that first
 * error is the one thrown.
 */
export async function runBatch<R>(
  operations: readonly ParsedOperation[],
  dispatch: (operation: ParsedOperation) => Promise<R>,
  limit: number = DEFAULT_READ_CONCURRENCY,
): Promise<R[]> {
  const results: R[] = [];
  for (const run of planBatch(operations)) {
    await mapWithConcurrency(run, limit, async (index) => {
      results[index] = await dispatch(operations[index]);
    });
  }
  return results;
}
