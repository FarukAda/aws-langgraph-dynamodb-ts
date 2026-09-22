import type { Operation } from '@langchain/langgraph-checkpoint';

import { runBatch } from '../../../../src/store/internal/batch-plan';

describe('runBatch preserves the order the caller wrote (STORE-09)', () => {
  const ns = ['a'];
  const put = (key: string, value: unknown) => ({ namespace: ns, key, value }) as Operation;
  const del = (key: string) => ({ namespace: ns, key, value: null }) as Operation;
  const get = (key: string) => ({ namespace: ns, key }) as Operation;
  const search = () => ({ namespacePrefix: ns, limit: 10, offset: 0 }) as Operation;

  /** Records the order operations were dispatched in, and answers a get from a tiny store. */
  function recorder() {
    const store = new Map<string, unknown>();
    const order: string[] = [];
    /**
     * `runBatch`'s dispatch parameter is typed `Promise<unknown>`; this fake's
     * own computation is synchronous and never throws, but it has three
     * return paths (put/get/search) and only one needs to be thenable to
     * satisfy `require-await` — the other two are plain values that `async`
     * itself still wraps in a `Promise`, so they are left as they are.
     */
    const dispatch = async (op: Operation): Promise<unknown> => {
      if ('value' in op) {
        order.push(`put:${op.key}`);
        if (op.value === null) store.delete(op.key);
        else store.set(op.key, op.value);
        return Promise.resolve(undefined);
      }
      if ('key' in op) {
        order.push(`get:${op.key}`);
        return store.get(op.key) ?? null;
      }
      order.push('search');
      return [...store.keys()];
    };
    return { store, order, dispatch };
  }

  /**
   * Running every write before every read returned the value for a
   * [delete, get] pair and the new value for a [get, put] pair — the opposite
   * of what the reference store answers, and reachable through
   * AsyncBatchedStore, which coalesces one tick into a single batch().
   */
  /** `AsyncBatchedStore` can flush a tick that enqueued nothing. */
  it('dispatches nothing for an empty batch', async () => {
    const { order, dispatch } = recorder();

    await expect(runBatch([], dispatch)).resolves.toEqual([]);

    expect(order).toEqual([]);
  });

  it('a get after a delete of the same item sees nothing', async () => {
    const { store, dispatch } = recorder();
    store.set('k', 'present');
    const results = await runBatch([del('k'), get('k')], dispatch);
    expect(results[1]).toBeNull();
  });

  it('a get before a put of the same item does not see it', async () => {
    const { dispatch } = recorder();
    const results = await runBatch([get('k'), put('k', 1)], dispatch);
    expect(results[0]).toBeNull();
  });

  it('a get after a put of the same item does see it', async () => {
    const { dispatch } = recorder();
    const results = await runBatch([put('k', 1), get('k')], dispatch);
    expect(results[1]).toBe(1);
  });

  it('a search sees the writes before it and not the ones after', async () => {
    const { dispatch } = recorder();
    const results = await runBatch([put('a', 1), search(), put('b', 2)], dispatch);
    expect(results[1]).toEqual(['a']);
  });

  it('runs operations on different items in one pass', async () => {
    const { order, dispatch } = recorder();
    await runBatch([get('x'), get('y'), get('z')], dispatch);
    expect(order).toHaveLength(3);
  });
});
