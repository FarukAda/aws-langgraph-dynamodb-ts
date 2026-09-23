import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  AsyncBatchedStore,
  type Item,
  type Operation,
  type SearchItem,
} from '@langchain/langgraph-checkpoint';

import { ErrorCode } from '../../../src/shared/errors/error-code';
import { partitionKey, sortKey } from '../../../src/store/internal/keys';
import { DynamoDBStore } from '../../../src/store/store';
import {
  answerDeleteReads,
  createStrictDocumentMock,
  deletedKeys,
  observableRow,
  resolveRowDeletes,
} from '../../shared/helpers/ddb-mock';

type Mock = ReturnType<typeof createStrictDocumentMock>['mock'];

function storeWithMock(): { store: DynamoDBStore; mock: Mock } {
  const { client, mock } = createStrictDocumentMock();
  return { store: new DynamoDBStore({ tableName: 'store', client }), mock };
}

/** Back the mock with a one-row table, so writes, reads and a search observe each other. */
function oneRowTable(mock: Mock): void {
  let stored: Record<string, unknown> | undefined;
  /** The pre-read a delete pins on sees the same row every other read does. */
  mock.on(GetCommand).callsFake(() => ({ Item: stored }));
  mock.on(QueryCommand).callsFake(() => ({ Items: stored ? [stored] : [] }));
  mock.on(PutCommand).callsFake((input) => {
    stored = input.Item;
    return {};
  });
  mock.on(TransactWriteCommand).callsFake(() => {
    stored = undefined;
    return {};
  });
}

const refusal = (field: string) => ({
  name: 'DynamoDBLangGraphError',
  code: ErrorCode.VALIDATION,
  context: { field },
});

/** A listing operation carrying `matchConditions`, with valid paging. */
const listing = (matchConditions: unknown): Operation =>
  ({ matchConditions, limit: 10, offset: 0 }) as Operation;

const put = (value: unknown, index?: unknown): Operation =>
  ({ namespace: ['ns'], key: 'k', value, index }) as Operation;

/**
 * Operations as a caller's own `batch()` — or LangGraph's runtime — hands them
 * over, bypassing every public method's own checks. Each rule has to hold here
 * too, so each is asserted by `code` and `context.field`.
 */
const REFUSED: [string, Operation, string][] = [
  ['a string search prefix', { namespacePrefix: 'x' as never }, 'namespacePrefix'],
  ['a number search label', { namespacePrefix: [1 as never] }, 'namespacePrefix element'],
  ['a separator search label', { namespacePrefix: ['a#b'] }, 'namespacePrefix element'],
  ['an empty search label', { namespacePrefix: ['a', ''] }, 'namespacePrefix element'],
  ['a bare condition', listing({ matchType: 'prefix', path: ['a'] }), 'matchConditions'],
  ['a null match condition', listing([null]), 'matchConditions'],
  ['an unknown match type', listing([{ matchType: 'infix', path: ['a'] }]), 'matchConditions'],
  ['a string prefix path', listing([{ matchType: 'prefix', path: 'x' }]), 'prefix'],
  ['a string suffix path', listing([{ matchType: 'suffix', path: 'x' }]), 'suffix'],
  ['a separator prefix label', listing([{ matchType: 'prefix', path: ['a#b'] }]), 'prefix element'],
  ['a number suffix label', listing([{ matchType: 'suffix', path: [1] }]), 'suffix element'],
  ['a string put value', put('x'), 'value'],
  ['a number put value', put(1), 'value'],
  ['an array put value', put([]), 'value'],
  ['a string put index', put({}, 'x'), 'index'],
  ['a null put index', put({}, null), 'index'],
  ['a non-string index path', put({}, [1]), 'index'],
];

/**
 * A caller's mistake in the `operations` argument itself, before any operation
 * is read: it used to reach the `in` operator or `for...of` and surface as an
 * `UNEXPECTED_ERROR`, which reports the caller's mistake as a failure from below.
 */
const MALFORMED_OPERATIONS: [string, unknown][] = [
  ['a string', 'x'],
  ['null', null],
  ['undefined', undefined],
  ['a single operation not wrapped in an array', { namespace: ['ns'], key: 'k' }],
  ['a null entry', [null]],
  ['a number entry', [42]],
  ['an array entry', [[]]],
];

describe('store.batch() refuses a malformed operations argument', () => {
  it.each(MALFORMED_OPERATIONS)('refuses %s, naming operations', async (_, operations) => {
    const { store, mock } = storeWithMock();
    await expect(store.batch(operations as never)).rejects.toMatchObject(refusal('operations'));
    expect(mock.calls()).toHaveLength(0);
  });

  it('answers an empty batch with an empty result, as upstream does', async () => {
    const { store, mock } = storeWithMock();
    await expect(store.batch([])).resolves.toEqual([]);
    expect(mock.calls()).toHaveLength(0);
  });
});

describe('store.batch() enforces every operation rule itself', () => {
  it.each(REFUSED)('refuses %s, naming the field, before any request', async (_, op, field) => {
    const { store, mock } = storeWithMock();
    await expect(store.batch([op])).rejects.toMatchObject(refusal(field));
    expect(mock.calls()).toHaveLength(0);
  });

  it('accepts an empty search prefix, which spans every namespace', async () => {
    const { store, mock } = storeWithMock();
    mock.on(ScanCommand).resolves({ Items: [] });
    await expect(store.batch([{ namespacePrefix: [] }])).resolves.toEqual([[]]);
    expect(mock.commandCalls(ScanCommand)).toHaveLength(1);
  });

  it('accepts wildcards, "." and "langgraph" labels in either path, and no conditions', async () => {
    const { store, mock } = storeWithMock();
    const row = (namespace: string[]) => ({
      PK: partitionKey(namespace),
      SK: sortKey(namespace, 'k'),
      namespace,
      key: 'k',
    });
    mock.on(ScanCommand).resolves({ Items: [row(['a', 'langgraph']), row(['b.c', 'd'])] });
    mock.on(QueryCommand).resolves({ Items: [row(['b.c', 'd'])] });
    await expect(
      store.batch([
        listing([{ matchType: 'suffix', path: ['langgraph'] }]),
        listing([{ matchType: 'prefix', path: ['b.c'] }]),
        listing([{ matchType: 'prefix', path: ['*', 'langgraph'] }]),
        listing([]),
      ]),
    ).resolves.toEqual([
      [['a', 'langgraph']],
      [['b.c', 'd']],
      [['a', 'langgraph']],
      [
        ['a', 'langgraph'],
        ['b.c', 'd'],
      ],
    ]);
  });

  it('accepts a put with index false or paths, and still deletes on a null value', async () => {
    const { store, mock } = storeWithMock();
    answerDeleteReads(mock, observableRow());
    mock.on(PutCommand).resolves({});
    resolveRowDeletes(mock);
    await store.batch([put({ a: 1 }, false)]);
    await store.batch([put({ a: 1 }, ['nonexistent'])]);
    await store.batch([put(null)]);
    expect(mock.commandCalls(PutCommand)).toHaveLength(2);
    expect(deletedKeys(mock)).toHaveLength(1);
  });

  it('validates the whole batch before running any of it, so nothing is half-applied', async () => {
    const { store, mock } = storeWithMock();
    oneRowTable(mock);
    await expect(store.batch([put({ a: 1 }), { namespacePrefix: ['a#b'] }])).rejects.toMatchObject(
      refusal('namespacePrefix element'),
    );
    await expect(store.batch([put({ a: 1 }), put('x')])).rejects.toMatchObject(refusal('value'));
    expect(mock.calls()).toHaveLength(0);
  });
});

/** The four item calls a round trip makes, over one route or another. */
interface ItemRoute {
  put(namespace: string[], key: string, value: Record<string, unknown>): Promise<unknown>;
  get(namespace: string[], key: string): Promise<Item | null>;
  search(namespacePrefix: string[]): Promise<SearchItem[]>;
  delete(namespace: string[], key: string): Promise<unknown>;
}

function viaBatch(store: DynamoDBStore): ItemRoute {
  return {
    put: (namespace, key, value) => store.batch([{ namespace, key, value }]),
    get: async (namespace, key) => (await store.batch([{ namespace, key }]))[0],
    search: async (namespacePrefix) => (await store.batch([{ namespacePrefix }]))[0],
    delete: (namespace, key) => store.batch([{ namespace, key, value: null }]),
  };
}

/**
 * Upstream refuses a `.` label only in `BaseStore.put` itself. The reference
 * store's `batch` accepts one, and LangGraph reaches a store only through
 * `batch`, so a graph keying memories by e-mail address must keep working here.
 */
async function roundTripAnEmailNamespace(route: ItemRoute): Promise<void> {
  const namespace = ['memories', 'jane.doe@example.com'];
  await route.put(namespace, 'profile', { name: 'Jane' });
  expect((await route.get(namespace, 'profile'))?.value).toEqual({ name: 'Jane' });
  expect((await route.search(['memories'])).map((item) => item.namespace)).toEqual([namespace]);
  await route.delete(namespace, 'profile');
  expect(await route.get(namespace, 'profile')).toBeNull();
}

describe('a "." label round-trips wherever upstream accepts it', () => {
  it('through store.batch()', async () => {
    const { store, mock } = storeWithMock();
    oneRowTable(mock);
    await roundTripAnEmailNamespace(viaBatch(store));
    expect(deletedKeys(mock)).toHaveLength(1);
  });
});

/**
 * LangGraph's runtime never calls a store's own `get`/`put`/`search`: it wraps
 * the store in upstream's `AsyncBatchedStore`, whose methods only enqueue an
 * operation, and flushes the queue through the store's `batch()`
 * (`@langchain/langgraph` `dist/pregel/loop.js:311`,
 * `@langchain/langgraph-checkpoint@1.1.5` `dist/store/batch.js:34-95`). The
 * queue only drains while the wrapper runs, so each test starts it and stops it.
 */
describe('through AsyncBatchedStore, as a running graph uses the store', () => {
  async function withBatched(
    store: DynamoDBStore,
    run: (batched: AsyncBatchedStore) => Promise<void>,
  ): Promise<void> {
    const batched = new AsyncBatchedStore(store);
    batched.start();
    try {
      await run(batched);
    } finally {
      await batched.stop();
    }
  }

  it('refuses a malformed search prefix and a non-object put value with a branded error', async () => {
    const { store, mock } = storeWithMock();
    await withBatched(store, async (batched) => {
      await expect(batched.search(['a#b'])).rejects.toMatchObject(
        refusal('namespacePrefix element'),
      );
      await expect(batched.put(['ns'], 'k', 'x' as never)).rejects.toMatchObject(refusal('value'));
    });
    expect(mock.calls()).toHaveLength(0);
  });

  it('writes nothing for calls coalesced into one batch with a malformed one', async () => {
    const { store, mock } = storeWithMock();
    oneRowTable(mock);
    await withBatched(store, async (batched) => {
      const settled = await Promise.allSettled([
        batched.put(['ns'], 'k', { a: 1 }),
        batched.search(['a#b']),
      ]);
      expect(settled.map(({ status }) => status)).toEqual(['rejected', 'rejected']);
    });
    expect(mock.calls()).toHaveLength(0);
  });

  it('round-trips put, get, search and delete under a "." label', async () => {
    const { store, mock } = storeWithMock();
    oneRowTable(mock);
    await withBatched(store, roundTripAnEmailNamespace);
    expect(deletedKeys(mock)).toHaveLength(1);
  });
});

/**
 * `null` paging was checked as `0` and then read as its default, so `limit:
 * null` returned ten items, where every other numeric option refuses `null`.
 */
describe('search paging given as null', () => {
  it.each(['offset', 'limit'])(
    'refuses %s: null on search and on a batch search',
    async (field) => {
      const { store, mock } = storeWithMock();
      await expect(store.search(['ns'], { [field]: null })).rejects.toMatchObject(refusal(field));
      await expect(
        store.batch([{ namespacePrefix: ['ns'], [field]: null } as never]),
      ).rejects.toMatchObject(refusal(field));
      expect(mock.calls()).toHaveLength(0);
    },
  );

  it('pages with limit: 5 and offset: 0 on both routes', async () => {
    const { store, mock } = storeWithMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    await expect(store.search(['ns'], { limit: 5, offset: 0 })).resolves.toEqual([]);
    await expect(store.batch([{ namespacePrefix: ['ns'], limit: 5, offset: 0 }])).resolves.toEqual([
      [],
    ]);
  });
});
