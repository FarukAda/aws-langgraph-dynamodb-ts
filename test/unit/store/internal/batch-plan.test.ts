import { runBatch } from '../../../../src/store/internal/batch-plan';
import { parseOperation, type ParsedOperation } from '../../../../src/store/internal/parse';

describe('runBatch preserves the order the caller wrote (STORE-09)', () => {
  const ns = ['a'];
  const put = (key: string, value: number) =>
    parseOperation({ namespace: ns, key, value: { value } });
  const del = (key: string) => parseOperation({ namespace: ns, key, value: null });
  const get = (key: string) => parseOperation({ namespace: ns, key });
  const search = () => parseOperation({ namespacePrefix: ns, limit: 10, offset: 0 });

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
    const dispatch = async (op: ParsedOperation): Promise<unknown> => {
      if (op.kind === 'put' || op.kind === 'delete') {
        order.push(`put:${op.address.key}`);
        if (op.kind === 'delete') store.delete(op.address.key);
        else store.set(op.address.key, op.value.value);
        return Promise.resolve(undefined);
      }
      if (op.kind === 'get') {
        order.push(`get:${op.address.key}`);
        return store.get(op.address.key) ?? null;
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

/**
 * An operation object carrying both `namespacePrefix` and `value` parses as a
 * search — `parseOperation` tests `namespacePrefix` first, as `dispatch` does
 * — so the planner must schedule it as the broad read it is, not as a write
 * addressing whatever `namespace`/`key` such an object happens to also carry.
 * Before this planner asked `touchOf` the same question `parseOperation` had
 * already answered, it tested `'value' in op` first and planned such an
 * operation as a write instead, so it could run beside an unrelated write in
 * the same segment where a search never may. A search object that also
 * carries `namespace` and `key` was planned as a get on that address, with the
 * same effect. No member of the `Operation` union mixes those keys, but the
 * literals below type-check as an `Operation` all the same — an excess-property
 * check on a union accepts a key any member declares — and a JavaScript caller
 * can pass anything. This is a scheduling change only: what the operation
 * itself does is unchanged.
 */
describe('the planner schedules a hybrid namespacePrefix+value object as the search it parses to', () => {
  const ns = ['a'];

  /** Runs `operations` two at a time and reports the most that ran at once. */
  async function maxConcurrency(operations: ParsedOperation[]): Promise<number> {
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatch = async (): Promise<unknown> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return null;
    };
    await runBatch(operations, dispatch, 2);
    return maxInFlight;
  }

  it('plans a search that also carries namespace and key as a broad read, not a get', async () => {
    const hybrid = parseOperation({
      namespacePrefix: ns,
      namespace: ns,
      key: 'k',
      limit: 10,
      offset: 0,
    });
    expect(hybrid.kind).toBe('search');
    const unrelatedPut = parseOperation({ namespace: ns, key: 'other', value: { v: 1 } });
    expect(await maxConcurrency([unrelatedPut, hybrid])).toBe(1);
  });

  it('is planned as a broad read, not a write on its (absent) address', () => {
    const hybrid = parseOperation({
      namespacePrefix: ns,
      value: { x: 1 },
      limit: 10,
      offset: 0,
    });
    expect(hybrid.kind).toBe('search');
  });

  it('does not run beside an unrelated write, where a shape-based write plan would have let it', async () => {
    const hybrid = parseOperation({
      namespacePrefix: ns,
      value: { x: 1 },
      limit: 10,
      offset: 0,
    });
    let inFlight = 0;
    let maxInFlight = 0;
    const dispatch = async (): Promise<unknown> => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return null;
    };

    await runBatch(
      [parseOperation({ namespace: ns, key: 'other', value: { v: 1 } }), hybrid],
      dispatch,
      2,
    );

    expect(maxInFlight).toBe(1);
  });
});
