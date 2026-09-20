import {
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { BaseStore, type Operation, type OperationResults } from '@langchain/langgraph-checkpoint';

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

type Call = (store: DynamoDBStore) => Promise<unknown>;

function storeWithMock(): {
  store: DynamoDBStore;
  mock: ReturnType<typeof createStrictDocumentMock>['mock'];
} {
  const { client, mock } = createStrictDocumentMock();
  return { store: new DynamoDBStore({ tableName: 'store', client }), mock };
}

/** A projected store row, keyed where its own namespace says it lives. */
const row = (namespace: string[]) => ({
  PK: partitionKey(namespace),
  SK: sortKey(namespace, 'k'),
  namespace,
  key: 'k',
});

/**
 * Every refusal, made through the public method. `field` is asserted alongside
 * `code` because a later check raising VALIDATION for some other reason would
 * otherwise hide the removal of the check under test.
 */
const REFUSED: [string, Call, string][] = [
  ['put under the reserved root', (s) => s.put(['langgraph'], 'k', {}), 'namespace'],
  ['put below the reserved root', (s) => s.put(['langgraph', 'x'], 'k', {}), 'namespace'],
  ['put with "." in a label', (s) => s.put(['users', 'a.b'], 'k', {}), 'namespace element'],
  ['put: namespace before value', (s) => s.put(['a#b'], 'k', null as never), 'namespace element'],
  ['put: key before value', (s) => s.put(['ns'], '', 1 as never), 'key'],
  ['put: address before upstream rules', (s) => s.put(['a.b'], '', {}), 'key'],
  ['put with a null value', (s) => s.put(['ns'], 'k', null as never), 'value'],
  ['put with a string value', (s) => s.put(['ns'], 'k', 'x' as never), 'value'],
  ['put with a number value', (s) => s.put(['ns'], 'k', 1 as never), 'value'],
  ['put with an array value', (s) => s.put(['ns'], 'k', [] as never), 'value'],
  ['put with a string index', (s) => s.put(['ns'], 'k', {}, 'x' as never), 'index'],
  ['put with a number index', (s) => s.put(['ns'], 'k', {}, 1 as never), 'index'],
  ['put with index true', (s) => s.put(['ns'], 'k', {}, true as never), 'index'],
  ['put with a null index', (s) => s.put(['ns'], 'k', {}, null as never), 'index'],
  ['put with an object index', (s) => s.put(['ns'], 'k', {}, {} as never), 'index'],
  ['put with a non-string index path', (s) => s.put(['ns'], 'k', {}, [1] as never), 'index'],
  ['get with an empty key', (s) => s.get(['ns'], ''), 'key'],
  ['get with a separator in the key', (s) => s.get(['ns'], 'a#b'), 'key'],
  ['delete with a non-string key', (s) => s.delete(['ns'], 123 as never), 'key'],
  ['listNamespaces with null options', (s) => s.listNamespaces(null as never), 'options'],
  ['listNamespaces with string options', (s) => s.listNamespaces('x' as never), 'options'],
  [
    'listNamespaces with an unread key',
    (s) => s.listNamespaces({ foo: 1 } as never),
    'options.foo',
  ],
  [
    'listNamespaces with a string prefix',
    (s) => s.listNamespaces({ prefix: 'x' as never }),
    'prefix',
  ],
  [
    'listNamespaces with a null prefix',
    (s) => s.listNamespaces({ prefix: null as never }),
    'prefix',
  ],
  [
    'listNamespaces with a string suffix',
    (s) => s.listNamespaces({ suffix: 'x' as never }),
    'suffix',
  ],
  [
    'a non-string prefix label',
    (s) => s.listNamespaces({ prefix: [1 as never] }),
    'prefix element',
  ],
  ['a separator in a prefix label', (s) => s.listNamespaces({ prefix: ['a#b'] }), 'prefix element'],
  ['a null suffix label', (s) => s.listNamespaces({ suffix: [null as never] }), 'suffix element'],
  ['a separator in a suffix label', (s) => s.listNamespaces({ suffix: ['a#b'] }), 'suffix element'],
  ['listNamespaces with limit -1', (s) => s.listNamespaces({ limit: -1 }), 'limit'],
  ['listNamespaces with maxDepth 0', (s) => s.listNamespaces({ maxDepth: 0 }), 'maxDepth'],
  ['search with a string prefix', (s) => s.search('x' as never), 'namespacePrefix'],
  ['search with a null prefix', (s) => s.search(null as never), 'namespacePrefix'],
  ['search with a number label', (s) => s.search([123 as never]), 'namespacePrefix element'],
  ['search with a null label', (s) => s.search([null as never]), 'namespacePrefix element'],
  ['search with a separator label', (s) => s.search(['a#b']), 'namespacePrefix element'],
  ['search with an empty label', (s) => s.search(['users', '']), 'namespacePrefix element'],
  [
    'search: prefix before options',
    (s) => s.search(['a#b'], null as never),
    'namespacePrefix element',
  ],
  ['reconcileVectorIndex with no prefix', (s) => s.reconcileVectorIndex([]), 'namespacePrefix'],
  [
    'reconcileVectorIndex with a separator label',
    (s) => s.reconcileVectorIndex(['a#b']),
    'namespacePrefix element',
  ],
  [
    'batch get with a separator',
    (s) => s.batch([{ namespace: ['a#b'], key: 'k' }]),
    'namespace element',
  ],
];

describe('DynamoDBStore get/put/delete/listNamespaces/search refuse input in this package (H-09)', () => {
  it.each(REFUSED)('refuses %s, naming the field, before any request', async (_, call, field) => {
    const { store, mock } = storeWithMock();
    await expect(call(store)).rejects.toMatchObject({
      name: 'ValidationError',
      code: ErrorCode.VALIDATION,
      context: { field },
    });
    expect(mock.calls()).toHaveLength(0);
  });
});

describe('what stays legal', () => {
  it('put, get and delete round-trip an item', async () => {
    const { store, mock } = storeWithMock();
    let stored: Record<string, unknown> | undefined;
    /** The pre-read a delete pins on sees the same row every other read does. */
    mock.on(GetCommand).callsFake(() => ({ Item: stored }));
    mock.on(PutCommand).callsFake((input) => {
      stored = input.Item;
      return {};
    });
    mock.on(TransactWriteCommand).callsFake(() => {
      stored = undefined;
      return {};
    });
    await store.put(['users', 'u1'], 'profile', { name: 'Faruk' });
    expect((await store.get(['users', 'u1'], 'profile'))?.value).toEqual({ name: 'Faruk' });
    await store.delete(['users', 'u1'], 'profile');
    expect(deletedKeys(mock)).toHaveLength(1);
    expect(await store.get(['users', 'u1'], 'profile')).toBeNull();
  });

  it('a put of null through batch is still the delete operation', async () => {
    const { store, mock } = storeWithMock();
    answerDeleteReads(mock, observableRow());
    resolveRowDeletes(mock);
    await store.batch([{ namespace: ['ns'], key: 'k', value: null }]);
    expect(deletedKeys(mock)).toHaveLength(1);
  });

  it('put accepts index false, an index path absent from the value, an empty index and none', async () => {
    const { store, mock } = storeWithMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    await store.put(['ns'], 'a', { a: 1 }, false);
    await store.put(['ns'], 'b', { a: 1 }, ['nonexistent']);
    await store.put(['ns'], 'c', { a: 1 }, []);
    await store.put(['ns'], 'd', { a: 1 });
    expect(mock.commandCalls(PutCommand)).toHaveLength(4);
  });

  it('put accepts members JSON drops, and "langgraph" anywhere but the root', async () => {
    const { store, mock } = storeWithMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    await store.put(['ns'], 'a', { a: undefined });
    await store.put(['ns'], 'b', { a: () => 1 });
    await store.put(['users', 'langgraph'], 'c', {});
    expect(mock.commandCalls(PutCommand)).toHaveLength(3);
  });

  it('listNamespaces keeps "*" a wildcard in prefix and suffix, leading or not', async () => {
    const { store, mock } = storeWithMock();
    const rows = [row(['users', 'u1']), row(['users', 'u2']), row(['orgs', 'u1'])];
    mock.on(ScanCommand).resolves({ Items: rows });
    mock.on(QueryCommand).resolves({ Items: rows.slice(0, 2) });
    const byU1 = [
      ['orgs', 'u1'],
      ['users', 'u1'],
    ];
    await expect(store.listNamespaces({ prefix: ['*', 'u1'] })).resolves.toEqual(byU1);
    await expect(store.listNamespaces({ suffix: ['*', 'u1'] })).resolves.toEqual(byU1);
    await expect(store.listNamespaces({ suffix: ['*'] })).resolves.toHaveLength(3);
    await expect(store.listNamespaces({ prefix: ['users', '*'] })).resolves.toEqual([
      ['users', 'u1'],
      ['users', 'u2'],
    ]);
  });

  /**
   * Upstream refuses a `.` label and a `"langgraph"` root in `BaseStore.put`
   * alone. The reference store's `batch`, and so LangGraph's runtime, accepts
   * both, and every other method here does too.
   */
  it('get, delete, search, listNamespaces and reconcile accept "." and a "langgraph" root', async () => {
    const { store, mock } = storeWithMock();
    answerDeleteReads(mock, observableRow());
    resolveRowDeletes(mock);
    mock.on(QueryCommand).resolves({ Items: [] });
    mock.on(ScanCommand).resolves({ Items: [row(['a', 'langgraph']), row(['langgraph', 'b.c'])] });
    await expect(store.get(['a.b'], 'k')).resolves.toBeNull();
    await expect(store.get(['langgraph'], 'k')).resolves.toBeNull();
    await expect(store.delete(['langgraph', 'a.b'], 'k')).resolves.toBeUndefined();
    await expect(store.search(['langgraph'])).resolves.toEqual([]);
    await expect(store.search(['users', 'a.b'])).resolves.toEqual([]);
    await expect(store.listNamespaces({ suffix: ['langgraph'] })).resolves.toEqual([
      ['a', 'langgraph'],
    ]);
    await expect(store.listNamespaces({ prefix: ['*', 'b.c'] })).resolves.toEqual([
      ['langgraph', 'b.c'],
    ]);
    await expect(store.reconcileVectorIndex(['a.b'])).rejects.toMatchObject({
      context: { field: 'vectorBackend' },
    });
    expect(deletedKeys(mock)).toHaveLength(1);
  });

  it('listNamespaces answers limit 0 with nothing and an empty prefix with everything', async () => {
    const { store, mock } = storeWithMock();
    mock.on(ScanCommand).resolves({ Items: [row(['a']), row(['b'])] });
    await expect(store.listNamespaces({ limit: 0 })).resolves.toEqual([]);
    await expect(store.listNamespaces({ prefix: [] })).resolves.toEqual([['a'], ['b']]);
    await expect(store.listNamespaces(undefined)).resolves.toEqual([['a'], ['b']]);
  });

  it('search accepts an empty prefix, which spans every namespace', async () => {
    const { store, mock } = storeWithMock();
    mock.on(ScanCommand).resolves({ Items: [] });
    await expect(store.search([])).resolves.toEqual([]);
    expect(mock.commandCalls(ScanCommand)).toHaveLength(1);
  });
});

/**
 * Upstream `BaseStore`'s own convenience methods, recording the operations they
 * build instead of running them.
 */
class ReferenceStore extends BaseStore {
  readonly operations: Operation[] = [];

  async batch<Op extends Operation[]>(operations: Op): Promise<OperationResults<Op>> {
    this.operations.push(...operations);
    return operations.map(() => null) as OperationResults<Op>;
  }
}

const SAME_OPERATIONS: [string, (store: BaseStore) => Promise<unknown>][] = [
  ['get', (s) => s.get(['users', 'u1'], 'k')],
  ['put', (s) => s.put(['users', 'u1'], 'k', { a: 1 })],
  ['put with index false', (s) => s.put(['users'], 'k', { a: 1 }, false)],
  ['put with index paths', (s) => s.put(['users'], 'k', { a: 1 }, ['a'])],
  ['delete', (s) => s.delete(['users', 'u1'], 'k')],
  ['listNamespaces with no options', (s) => s.listNamespaces()],
  ['listNamespaces with empty options', (s) => s.listNamespaces({})],
  ['listNamespaces with a prefix', (s) => s.listNamespaces({ prefix: ['users'] })],
  ['listNamespaces with an empty prefix', (s) => s.listNamespaces({ prefix: [] })],
  ['listNamespaces with a suffix', (s) => s.listNamespaces({ suffix: ['*'] })],
  ['listNamespaces with limit 0', (s) => s.listNamespaces({ limit: 0 })],
  [
    'listNamespaces with every option',
    (s) => s.listNamespaces({ prefix: ['a'], suffix: ['b'], maxDepth: 2, limit: 5, offset: 1 }),
  ],
];

describe('the overrides build exactly the operations upstream BaseStore builds', () => {
  it.each(SAME_OPERATIONS)('%s', async (_, call) => {
    const reference = new ReferenceStore();
    await call(reference);
    const { store } = storeWithMock();
    const batch = jest
      .spyOn(store, 'batch')
      .mockImplementation(async (operations) => operations.map(() => null) as never);
    await call(store);
    expect(batch.mock.calls.flatMap(([operations]) => operations)).toStrictEqual(
      reference.operations,
    );
  });
});
