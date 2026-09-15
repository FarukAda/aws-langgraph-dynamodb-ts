/**
 * Map `items` through `fn` with at most `limit` calls in flight.
 *
 * Accepts: `items` — any length, including empty, which calls `fn` never.
 * `limit` — calls in flight; a value below 1 degrades to sequential rather
 * than stalling, and one above `items.length` starts only as many workers as
 * there are items. `fn` — receives the item and its index.
 *
 * Returns: the results in **input** order, not completion order.
 *
 * Throws: the first rejection. No further item is started after it, the calls
 * already in flight are allowed to settle, and that first error is the one
 * thrown — a later failure never displaces it.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  let failure: Error | undefined;
  const worker = async (): Promise<void> => {
    while (failure === undefined && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        failure ??= error as Error;
      }
    }
  };
  const workers = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workers }, worker));
  if (failure !== undefined) throw failure;
  return results;
}
