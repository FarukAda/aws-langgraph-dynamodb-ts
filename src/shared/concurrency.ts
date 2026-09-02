/**
 * Map `items` through `fn` with at most `limit` calls in flight, preserving
 * input order in the result. The first rejection wins: no further item is
 * started, the calls already in flight settle, and that error propagates.
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
