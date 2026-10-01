import { planBatch, runBatch } from '../../../../src/store/internal/batch-plan';
import { parseOperation, type ParsedOperation } from '../../../../src/store/internal/parse';

const ns = ['a'];
const put = (key: string, value: number) =>
  parseOperation({ namespace: ns, key, value: { value } });
const del = (key: string) => parseOperation({ namespace: ns, key, value: null });
const get = (key: string) => parseOperation({ namespace: ns, key });
const search = () => parseOperation({ namespacePrefix: ns, limit: 10, offset: 0 });
const list = () =>
  parseOperation({ matchConditions: [], maxDepth: undefined, limit: 10, offset: 0 });

/** Records the order operations were dispatched in, and answers a read from a tiny store. */
function recorder() {
  const store = new Map<string, unknown>();
  const order: string[] = [];
  /**
   * `runBatch`'s dispatch parameter is typed `Promise<unknown>`; this fake's
   * own computation is synchronous and never throws, but it has several
   * return paths and only one needs to be thenable to satisfy
   * `require-await` — the others are plain values that `async` itself still
   * wraps in a `Promise`, so they are left as they are.
   */
  const dispatch = async (op: ParsedOperation): Promise<unknown> => {
    if (op.kind === 'put' || op.kind === 'delete') {
      order.push(`${op.kind}:${op.address.key}`);
      if (op.kind === 'delete') store.delete(op.address.key);
      else store.set(op.address.key, op.value.value);
      return Promise.resolve(null);
    }
    if (op.kind === 'get') {
      order.push(`get:${op.address.key}`);
      return store.get(op.address.key) ?? null;
    }
    order.push(op.kind);
    return [...store.keys()];
  };
  return { store, order, dispatch };
}

/**
 * The reference store answers every read of a batch as the batch found things
 * and applies the puts afterwards, the last per key winning. `AsyncBatchedStore`
 * coalesces everything one tick enqueues into a single `batch()`, so two tasks
 * of one superstep reach this path, and the answers they get must not depend
 * on which of them was enqueued first.
 */
describe('runBatch answers every read before it applies any write, as the reference does', () => {
  /** `AsyncBatchedStore` can flush a tick that enqueued nothing. */
  it('dispatches nothing for an empty batch', async () => {
    const { order, dispatch } = recorder();

    await expect(runBatch([], dispatch)).resolves.toEqual([]);

    expect(order).toEqual([]);
  });

  it('a get after a delete of the same item still sees it', async () => {
    const { store, dispatch } = recorder();
    store.set('k', 'present');
    const results = await runBatch([del('k'), get('k')], dispatch);
    expect(results).toEqual([null, 'present']);
    expect(store.has('k')).toBe(false);
  });

  it('a get after a put of the same item does not see it', async () => {
    const { store, dispatch } = recorder();
    const results = await runBatch([put('k', 1), get('k')], dispatch);
    expect(results).toEqual([null, null]);
    expect(store.get('k')).toBe(1);
  });

  it('a search and a listing see none of the writes in their batch, wherever they sit', async () => {
    const { dispatch } = recorder();
    const results = await runBatch([put('a', 1), search(), put('b', 2), list()], dispatch);
    expect(results).toEqual([null, [], null, []]);
  });

  it('sends one write per item, the last one written, and answers the superseded ones null unsent', async () => {
    const { store, order, dispatch } = recorder();
    const results = await runBatch(
      [put('k', 1), put('k', 2), put('j', 1), del('j'), del('m'), put('m', 3)],
      dispatch,
    );
    expect(results).toEqual([null, null, null, null, null, null]);
    expect(order).toEqual(['put:k', 'delete:j', 'put:m']);
    expect(store.get('k')).toBe(2);
    expect(store.has('j')).toBe(false);
    expect(store.get('m')).toBe(3);
  });

  it('runs every read in one pass and every write in the next', async () => {
    const { order, dispatch } = recorder();
    await runBatch([put('x', 1), get('x'), get('y'), del('z'), search()], dispatch);
    expect(order).toEqual(['get:x', 'get:y', 'search', 'put:x', 'delete:z']);
  });

  /**
   * Within a phase the operations run together, and `AsyncBatchedStore` hands
   * each caller its result by index: a slower first read must still land in
   * the first slot.
   */
  it('returns the results in operation order whatever order they finish in', async () => {
    const dispatch = async (op: ParsedOperation): Promise<unknown> => {
      const key = op.kind === 'get' ? op.address.key : '';
      const ticks = key === 'slow' ? 3 : 0;
      for (let tick = 0; tick < ticks; tick += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      return `read ${key}`;
    };
    await expect(runBatch([get('slow'), get('fast')], dispatch)).resolves.toEqual([
      'read slow',
      'read fast',
    ]);
  });
});

describe('planBatch', () => {
  it('lists the reads in order and the last write per item in order', () => {
    const plan = planBatch([put('k', 1), get('k'), put('k', 2), del('j'), search(), put('j', 3)]);
    expect(plan).toEqual({ reads: [1, 4], writes: [2, 5] });
  });

  /**
   * An operation object carrying both `namespacePrefix` and `value` parses as
   * a search — `parseOperation` tests `namespacePrefix` first, as `dispatch`
   * does — so the planner must schedule it as the read it is, not as a write
   * on whatever `namespace`/`key` such an object happens to also carry. No
   * member of the `Operation` union mixes those keys, but the literals below
   * type-check as an `Operation` all the same — an excess-property check on a
   * union accepts a key any member declares — and a JavaScript caller can pass
   * anything.
   */
  it('plans a hybrid namespacePrefix+value object as the search it parses to', () => {
    const hybrid = parseOperation({
      namespacePrefix: ns,
      namespace: ns,
      key: 'k',
      value: { x: 1 },
      limit: 10,
      offset: 0,
    });
    expect(hybrid.kind).toBe('search');
    expect(planBatch([put('k', 1), hybrid])).toEqual({ reads: [1], writes: [0] });
  });
});

describe('the budget one phase shares', () => {
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

  it('keeps at most the limit in flight within a phase', async () => {
    expect(await maxConcurrency([get('a'), get('b'), get('c'), get('d')])).toBe(2);
  });

  it('never runs a read beside a write', async () => {
    expect(await maxConcurrency([put('a', 1), search()])).toBe(1);
  });
});
