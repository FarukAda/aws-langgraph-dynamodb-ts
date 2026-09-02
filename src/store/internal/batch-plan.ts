import type { Operation, PutOperation } from '@langchain/langgraph-checkpoint';

import { mapWithConcurrency } from '../../shared/concurrency';
import { DEFAULT_READ_CONCURRENCY } from '../../shared/constants';

/**
 * How one `batch()` call is dispatched: the positions of its writes, grouped
 * by the item they touch, and the positions of its reads.
 */
interface BatchPlan {
  /** Each group holds the puts/deletes of one `(namespace, key)`, in operation order. */
  writeGroups: number[][];
  reads: number[];
}

function itemOf(op: PutOperation): string {
  return JSON.stringify([op.namespace, op.key]);
}

/**
 * Group a batch so that dependent operations stay ordered while independent
 * ones can run side by side. Two writes to the same item must land in the
 * order given, since the later one wins; writes to different items and all
 * reads are independent of each other.
 */
function planBatch(operations: readonly Operation[]): BatchPlan {
  const groups = new Map<string, number[]>();
  const reads: number[] = [];
  operations.forEach((op, index) => {
    if (!('value' in op)) {
      reads.push(index);
      return;
    }
    const item = itemOf(op);
    const group = groups.get(item);
    if (group) group.push(index);
    else groups.set(item, [index]);
  });
  return { writeGroups: [...groups.values()], reads };
}

/**
 * Run a batch: every write group serially within itself and groups
 * concurrently with each other, then every read concurrently, at most
 * {@link DEFAULT_READ_CONCURRENCY} operations in flight at a time. Results
 * come back in operation order. Writes complete before any read starts, so a
 * get or search in the same batch observes the puts beside it. Any failure
 * rejects the whole batch: no further operation is started, the ones already
 * in flight settle, and the first error propagates.
 */
export async function runBatch<R>(
  operations: readonly Operation[],
  dispatch: (operation: Operation) => Promise<R>,
): Promise<R[]> {
  const plan = planBatch(operations);
  const results: R[] = [];
  await mapWithConcurrency(plan.writeGroups, DEFAULT_READ_CONCURRENCY, async (group) => {
    for (const index of group) results[index] = await dispatch(operations[index]);
  });
  await mapWithConcurrency(plan.reads, DEFAULT_READ_CONCURRENCY, async (index) => {
    results[index] = await dispatch(operations[index]);
  });
  return results;
}
