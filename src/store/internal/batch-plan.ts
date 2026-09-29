/**
 * Hides how a batch runs concurrently and still in the order it was written.
 *
 * Operations on different items, and reads of the same item, share a run and
 * go in flight together; anything that could observe or overwrite an earlier
 * operation's effect starts the next run. A caller sees the order it wrote —
 * a `get` after a `put` of the same item sees it, a `search` sees every write
 * before it — and how independence is judged can change without the store.
 * The operations of one run also share the call's one decode budget, divided
 * between them, so a batch of concurrent searches costs no more memory than a
 * single one.
 */

import { DEFAULT_READ_CONCURRENCY, mapWithConcurrency } from '../../shared/concurrency.js';
import type { ParsedOperation, StoreAddress } from './parse.js';

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
 * observed in; empty returns empty. `dispatch` — handed each operation and
 * its share of the budget: `limit` divided by the operations its run keeps
 * in flight, and never less than one. `limit` — operations in flight within
 * one run.
 *
 * Returns: the results in operation order, not completion order.
 *
 * Throws: the first failure. Any failure rejects the whole batch: no operation
 * in a later run starts, the ones already in flight settle, and that first
 * error is the one thrown.
 *
 * Guarantees: the operations of one call decode at most `limit` payloads at
 * once between them, which is what `readConcurrency`'s documented memory
 * ceiling assumes.
 */
export async function runBatch<R>(
  operations: readonly ParsedOperation[],
  dispatch: (operation: ParsedOperation, readConcurrency: number) => Promise<R>,
  limit: number = DEFAULT_READ_CONCURRENCY,
): Promise<R[]> {
  const results: R[] = [];
  for (const run of planBatch(operations)) {
    // Each operation in flight may decode payloads of its own — a search
    // decodes up to its read concurrency at once — so a run divides the call's
    // one budget between them. A batch then holds `limit` decodes in flight,
    // not `limit` squared.
    const share = Math.max(1, Math.floor(limit / Math.min(limit, run.length)));
    await mapWithConcurrency(run, limit, async (index) => {
      results[index] = await dispatch(operations[index], share);
    });
  }
  return results;
}
