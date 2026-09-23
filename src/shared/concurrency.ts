/**
 * Map `items` through `fn` with at most `limit` calls in flight.
 *
 * Accepts: `items` — any length, including empty, which calls `fn` never.
 * `limit` — calls in flight; anything that is not a whole number of at least 1
 * degrades to sequential rather than stalling, and a value above `items.length`
 * starts only as many workers as there are items. The floor is a *range* test
 * rather than arithmetic on purpose: `Math.min(NaN, items.length)` is `NaN`,
 * so a `NaN` limit asked for `Array.from({ length: NaN })` workers — none —
 * and the call resolved to an empty array having invoked `fn` on nothing.
 * `refillDryShards` loops while any shard is dry around exactly this call, so
 * zero workers there was a busy-spin with no I/O and no way out; only the
 * required `concurrency` field kept it off typed paths. `fn` — receives the
 * item and its index.
 *
 * Returns: the results in **input** order, not completion order.
 *
 * Throws: the first rejection, whatever its value. No further item is started
 * after it, the calls already in flight are allowed to settle, and that first
 * error is the one thrown — a later failure never displaces it. Whether one
 * has happened is tracked by a flag rather than by testing the value, because
 * a rejection whose value is `undefined` is indistinguishable from no rejection
 * at all: it used to be swallowed, and its slot in the results stayed a hole.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  let failed = false;
  let failure: Error | undefined;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = await fn(items[index], index);
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error as Error;
        }
      }
    }
  };
  const workers = Math.min(limit >= 1 ? Math.floor(limit) : 1, Math.max(items.length, 1));
  await Promise.all(Array.from({ length: workers }, worker));
  /**
   * `failure` is stored `Error | undefined` only because that is as far as a
   * `catch` binding's value can be named without `unknown`, which is banned
   * in src; the JSDoc above states the real contract — whatever `fn` rejected
   * with, unchanged, and that can be `undefined` itself. The assertion below
   * changes nothing at runtime; it only lets `only-throw-error` see the type
   * this throw already had before that rule existed.
   */
  if (failed) throw failure as Error;
  return results;
}
