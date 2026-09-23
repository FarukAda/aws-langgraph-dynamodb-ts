import { mapWithConcurrency } from '../../../src/shared/concurrency';

/** A promise plus the handles that settle it, for hand-driven scheduling. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('mapWithConcurrency', () => {
  it('never runs more than `limit` calls at once and preserves input order', async () => {
    const gates = [0, 1, 2, 3, 4].map(() => deferred<void>());
    let inFlight = 0;
    let maxInFlight = 0;
    const started: number[] = [];
    const run = mapWithConcurrency([0, 1, 2, 3, 4], 2, async (item) => {
      started.push(item);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gates[item].promise;
      inFlight -= 1;
      return item * 10;
    });
    await tick();
    expect(started).toEqual([0, 1]);
    gates[1].resolve();
    await tick();
    expect(started).toEqual([0, 1, 2]);
    for (const gate of gates) gate.resolve();
    await expect(run).resolves.toEqual([0, 10, 20, 30, 40]);
    expect(maxInFlight).toBe(2);
  });

  it('keeps results in input order even when later items finish first', async () => {
    const gates = [deferred<void>(), deferred<void>(), deferred<void>()];
    const run = mapWithConcurrency(['a', 'b', 'c'], 3, async (item, index) => {
      await gates[index].promise;
      return item.toUpperCase();
    });
    gates[2].resolve();
    gates[0].resolve();
    gates[1].resolve();
    await expect(run).resolves.toEqual(['A', 'B', 'C']);
  });

  it('propagates the first rejection and starts no further items', async () => {
    const calls: number[] = [];
    await expect(
      mapWithConcurrency([1, 2, 3], 1, async (item) => {
        calls.push(item);
        if (item === 2) throw new Error('boom');
        return Promise.resolve(item);
      }),
    ).rejects.toThrow('boom');
    expect(calls).toEqual([1, 2]);
  });

  it('reports the first failure when several in-flight calls reject', async () => {
    const gates = [deferred<never>(), deferred<never>()];
    const run = mapWithConcurrency([0, 1], 2, (_item, index) =>
      Promise.resolve(gates[index].promise),
    );
    gates[1].reject(new Error('second'));
    await tick();
    gates[0].reject(new Error('first'));
    await expect(run).rejects.toThrow('second');
  });

  it('returns an empty array for no items without calling fn', async () => {
    const fn = jest.fn();
    await expect(mapWithConcurrency([], 8, fn)).resolves.toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  /**
   * `Math.min(NaN, items.length)` is `NaN`, so the worker count was
   * `Array.from({ length: NaN })` — zero workers. The call resolved to an empty
   * array having invoked `fn` on nothing, and `refillDryShards`, which loops
   * while any shard is dry around exactly this call, then span forever with no
   * I/O and no way out.
   */
  it('starts one worker, not none, for a concurrency that is not a whole number', async () => {
    for (const limit of [Number.NaN, 0.5, -3]) {
      const seen: number[] = [];
      await expect(
        mapWithConcurrency([1, 2, 3], limit, (item) => {
          seen.push(item);
          return Promise.resolve(item * 2);
        }),
      ).resolves.toEqual([2, 4, 6]);
      expect(seen).toEqual([1, 2, 3]);
    }
  });

  /** `Infinity` still means "as many as there are items", as it always did. */
  it('lets an infinite concurrency start one worker per item', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency([1, 2, 3], Number.POSITIVE_INFINITY, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      inFlight -= 1;
    });
    expect(maxInFlight).toBe(3);
  });

  /**
   * `failure ??= error` cannot tell "nothing has failed yet" from a rejection
   * whose value *is* `undefined`, so such a rejection was swallowed: the call
   * resolved, and the failed item's slot in the results stayed a hole. A
   * third-party backend that rejects with `undefined` is the reachable case.
   */
  it('throws a rejection whose value is undefined instead of leaving a hole', async () => {
    let caught: unknown = 'nothing was thrown';
    const run = mapWithConcurrency([1, 2], 1, (item) =>
      Promise.resolve(item === 1 ? Promise.reject(undefined) : Promise.resolve(item)),
    );
    try {
      await run;
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeUndefined();
  });

  it('treats a limit below one as one', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    await mapWithConcurrency([1, 2, 3], 0, async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick();
      inFlight -= 1;
    });
    expect(maxInFlight).toBe(1);
  });
});
