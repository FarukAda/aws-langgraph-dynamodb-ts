/**
 * CONTRACT tier — DynamoDBStore vs. LangGraph's BaseStore (REQ-28 / AC-24).
 *
 * Proves our store satisfies the upstream `BaseStore` interface shape AND
 * behavior against the strict aws-sdk-client-mock (no real DynamoDB). The
 * `batch()` abstract method is the one our store overrides to accept the
 * `RunnableConfig` carrying `user_id`; it is exercised directly with each
 * upstream Operation variant (GetOperation, PutOperation, SearchOperation,
 * ListNamespacesOperation) so the `OperationResults` positional-typing contract
 * is honored at runtime.
 *
 * CONFORMANCE GAP (characterized, not fixed here): the inherited BaseStore
 * convenience methods get()/put()/search()/delete()/listNamespaces() take no
 * `RunnableConfig`, so they have no way to supply the `user_id` our store
 * requires; invoking them surfaces the documented user_id error. The contract is
 * therefore satisfiable only through `batch(operations, config)`. These tests
 * lock that reality rather than papering over it.
 *
 * Mock-backed only: the store builds its own DynamoDBDocumentClient, which
 * mockClient(DynamoDBDocumentClient) intercepts at the command layer.
 */
import { DeleteCommand, GetCommand, QueryCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { BaseStore, type Item, type SearchItem } from '@langchain/langgraph-checkpoint';

import { DynamoDBStore } from '../../src/index';
import { USER_ID } from '../shared/fixtures/test-data';
import { expectNoUnexpectedCommands } from '../shared/helpers/strict-ddb-assertions';
import { createStrictDdbMock, type StrictDdbMock } from '../shared/mocks/dynamodb';

const MEMORY_TABLE = 'memory-table';
const NS = ['ns'];
const KEY = 'key1';
const CONFIG = { configurable: { user_id: USER_ID } };

function makeStore(): DynamoDBStore {
  return new DynamoDBStore({ memoryTableName: MEMORY_TABLE });
}

describe('DynamoDBStore conformance to BaseStore', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  it('is an instance of the upstream BaseStore and exposes the full BaseStore method set', () => {
    const store = makeStore();
    // Subclassing the upstream abstract BaseStore is the load-bearing contract.
    expect(store).toBeInstanceOf(BaseStore);
    // Abstract batch (overridden) + concrete convenience methods required by BaseStore.
    expect(typeof store.batch).toBe('function');
    expect(typeof store.get).toBe('function');
    expect(typeof store.put).toBe('function');
    expect(typeof store.search).toBe('function');
    expect(typeof store.delete).toBe('function');
    expect(typeof store.listNamespaces).toBe('function');
    // start/stop lifecycle hooks declared on BaseStore.
    expect(typeof store.start).toBe('function');
    expect(typeof store.stop).toBe('function');
  }); // AC-24

  it('batch() returns results positionally aligned with the operations per OperationResults (Get + Put)', async () => {
    ddb.mock.on(GetCommand).resolves({
      Item: {
        key: KEY,
        value: { data: 'v' },
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_500_000,
      },
    });
    ddb.mock.on(UpdateCommand).resolves({});

    const results = await makeStore().batch(
      [
        { namespace: NS, key: KEY },
        { namespace: NS, key: 'key2', value: { data: 'w' } },
      ],
      CONFIG,
    );

    // First slot is the GetOperation result (Item | null); second is the
    // PutOperation result (void/undefined). Order + cardinality is the contract.
    expect(results).toHaveLength(2);
    const item = results[0] as Item | null;
    expect(item).not.toBeNull();
    expect(item?.key).toBe(KEY);
    expect(item?.namespace).toEqual(NS);
    expect(item?.createdAt).toBeInstanceOf(Date);
    expect(results[1]).toBeUndefined();
    expectNoUnexpectedCommands(ddb.mock, [GetCommand, UpdateCommand]);
  }); // AC-24

  it('batch() GetOperation yields null for an absent item, honoring the Item | null result contract', async () => {
    ddb.mock.on(GetCommand).resolves({ Item: undefined });
    const results = await makeStore().batch([{ namespace: NS, key: KEY }], CONFIG);
    expect(results).toEqual([null]);
    expectNoUnexpectedCommands(ddb.mock, [GetCommand]);
  }); // AC-24

  it('batch() PutOperation with a null value performs a delete (DeleteCommand) and yields void', async () => {
    ddb.mock.on(DeleteCommand).resolves({});
    const results = await makeStore().batch([{ namespace: NS, key: KEY, value: null }], CONFIG);
    expect(results[0]).toBeUndefined();
    expect(ddb.mock.commandCalls(DeleteCommand)).toHaveLength(1);
    expectNoUnexpectedCommands(ddb.mock, [DeleteCommand]);
  }); // AC-24

  it('batch() SearchOperation yields a SearchItem[] honoring the upstream search-result shape', async () => {
    ddb.mock.on(QueryCommand).resolves({
      Items: [
        {
          namespace: NS.join('/'),
          key: KEY,
          value: { data: 'v' },
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_000,
        },
      ],
      LastEvaluatedKey: undefined,
    });
    const results = await makeStore().batch(
      [{ namespacePrefix: NS, limit: 10, offset: 0 }],
      CONFIG,
    );
    const searchItems = results[0] as SearchItem[];
    expect(Array.isArray(searchItems)).toBe(true);
    expect(searchItems).toHaveLength(1);
    expect(searchItems[0].key).toBe(KEY);
    expect(searchItems[0].namespace).toEqual(NS);
    expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
  }); // AC-24

  it('batch() ListNamespacesOperation yields string[][] honoring the upstream namespace-listing shape', async () => {
    ddb.mock.on(QueryCommand).resolves({
      Items: [{ namespace: 'a/y' }, { namespace: 'b/x' }],
      LastEvaluatedKey: undefined,
    });
    const results = await makeStore().batch(
      [{ matchConditions: [], maxDepth: undefined, limit: 100, offset: 0 }],
      CONFIG,
    );
    expect(results[0]).toEqual([
      ['a', 'y'],
      ['b', 'x'],
    ]);
    expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
  }); // AC-24

  it('batch() rejects without a user_id in the config before any DDB call (contract negative)', async () => {
    await expect(makeStore().batch([{ namespace: NS, key: KEY }])).rejects.toThrow(
      'Field user_id is required in the RunnableConfig for DynamoDBStore.',
    );
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-24

  it('inherited get() without a config surfaces the documented user_id error (characterized gap)', async () => {
    // The BaseStore convenience methods carry no RunnableConfig, so they cannot
    // supply the required user_id; the contract is reachable only via batch().
    await expect(makeStore().get(NS, KEY)).rejects.toThrow(
      'Field user_id is required in the RunnableConfig for DynamoDBStore.',
    );
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-24
});
