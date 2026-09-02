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
        return item;
      }),
    ).rejects.toThrow('boom');
    expect(calls).toEqual([1, 2]);
  });

  it('reports the first failure when several in-flight calls reject', async () => {
    const gates = [deferred<never>(), deferred<never>()];
    const run = mapWithConcurrency([0, 1], 2, (_item, index) => gates[index].promise);
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
