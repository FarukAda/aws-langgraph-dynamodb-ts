/**
 * Hides how a batch runs: every read first, against the state the batch found,
 * then one write per item, concurrently within each phase.
 *
 * That is how the reference store evaluates a batch — a get, a search or a
 * listing is answered as the batch found things, and the puts are applied
 * afterwards, the last one per item winning — so a graph developed against it
 * gets the same answers here, and two tasks of one superstep that touch the
 * same item get answers that do not depend on which of them was enqueued
 * first. The operations of one phase share the call's one decode budget,
 * divided between them, so a batch of concurrent searches costs no more memory
 * than a single one.
 */

import { DEFAULT_READ_CONCURRENCY, mapWithConcurrency } from '../../shared/concurrency.js';
import type { ParsedOperation, StoreAddress } from './parse.js';

/** The two phases of a batch: the indices of its reads, and of the one write kept per item. */
export interface BatchPlan {
  readonly reads: number[];
  readonly writes: number[];
}

function itemOf(address: StoreAddress): string {
  return JSON.stringify([address.namespace, address.key]);
}

/**
 * Split a batch into the reads it answers first and the writes it applies
 * afterwards.
 *
 * Accepts: `operations` — in caller order.
 *
 * Returns: the indices of every get, search and listing, in caller order, and
 * the index of the last put or delete addressing each item, in caller order.
 * An earlier write to the same item is superseded before it is sent: the
 * reference applies only the last put per key, and sending both would race
 * two compare-and-swaps for an outcome the batch has already decided.
 *
 * Throws: nothing.
 */
export function planBatch(operations: readonly ParsedOperation[]): BatchPlan {
  const reads: number[] = [];
  const lastWrite = new Map<string, number>();
  operations.forEach((op, index) => {
    if (op.kind === 'put' || op.kind === 'delete') lastWrite.set(itemOf(op.address), index);
    else reads.push(index);
  });
  return { reads, writes: [...lastWrite.values()].sort((a, b) => a - b) };
}

/**
 * Run a batch: its reads concurrently, at most `limit` in flight, then its
 * writes the same way. Results come back in operation order.
 *
 * Accepts: `operations` — in caller order. `dispatch` — handed each operation
 * and its share of the budget: `limit` divided by the operations its phase
 * keeps in flight, and never less than one. `limit` — operations in flight
 * within one phase.
 *
 * Returns: the results in operation order, not completion order; a write
 * superseded by a later one to the same item answers `null`, as the write
 * that was sent does, without having been sent.
 *
 * Throws: the first failure. Any failure rejects the whole batch: no operation
 * in a later phase starts, the ones already in flight settle, and that first
 * error is the one thrown.
 *
 * Guarantees: every read sees the state before any of the batch's writes, and
 * the operations of one call decode at most `limit` payloads at once between
 * them, which is what `readConcurrency`'s documented memory ceiling assumes.
 */
export async function runBatch<R>(
  operations: readonly ParsedOperation[],
  dispatch: (operation: ParsedOperation, readConcurrency: number) => Promise<R>,
  limit: number = DEFAULT_READ_CONCURRENCY,
): Promise<(R | null)[]> {
  const results: (R | null)[] = operations.map(() => null);
  const { reads, writes } = planBatch(operations);
  for (const phase of [reads, writes]) {
    if (phase.length === 0) continue;
    // Each operation in flight may decode payloads of its own — a search
    // decodes up to its read concurrency at once — so a phase divides the
    // call's one budget between them. A batch then holds `limit` decodes in
    // flight, not `limit` squared.
    const share = Math.max(1, Math.floor(limit / Math.min(limit, phase.length)));
    await mapWithConcurrency(phase, limit, async (index) => {
      results[index] = await dispatch(operations[index], share);
    });
  }
  return results;
}
