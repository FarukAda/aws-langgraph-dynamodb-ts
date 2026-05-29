/**
 * Unit tests for src/store/index.ts (DynamoDBStore orchestration class).
 *
 * This characterizes the public BaseStore surface (get/put/search/listNamespaces/
 * delete) and the batch() dispatcher that fans operations out to the action
 * functions. The store builds its OWN DynamoDBDocument client internally, which
 * `mockClient(DynamoDBDocumentClient)` (via createStrictDdbMock) intercepts — so
 * every test constructs `new DynamoDBStore({ memoryTableName })` with NO explicit
 * client and asserts the exact DDB command class + full `.input`.
 *
 * Locks down:
 *  - getUserId enforcement (missing / non-string user_id rejects with no DDB call)
 *  - batch() op-type dispatch: get vs put vs search vs listNamespaces, and the
 *    "unrecognized operation" branch
 *  - validateBatchSize (empty batch / over-limit) before any DDB call
 *  - the RunnableConfig.signal abort short-circuit
 *  - fallbackToLexicalOnEmbeddingFailure wiring into searchOperation
 *  - ttlDays + embedding wiring into putOperation
 *  - destroy() owns-client vs injected-client behavior
 *
 * Frozen time (Date.now() === FROZEN_NOW_MS) and seeded Math.random come from the
 * global setupFilesAfterEnv; deterministic values are pinned to constants.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocument,
  GetCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  GetOperation,
  ListNamespacesOperation,
  Operation,
  PutOperation,
  SearchOperation,
} from '@langchain/langgraph';

import { DynamoDBStore } from '../../../src/store';
import { NAMESPACE, USER_ID, makeRunnableConfig } from '../../shared/fixtures/test-data';
import { preAbortedSignal } from '../../shared/helpers/abort';
import { EXPECTED_TTL_30D, FROZEN_NOW_MS } from '../../shared/helpers/frozen-time';
import {
  expectExactDeleteCommand,
  expectExactGetCommand,
  expectExactQueryCommand,
  expectExactUpdateCommand,
  expectNoUnexpectedCommands,
} from '../../shared/helpers/strict-ddb-assertions';
import { createStrictDdbMock, type StrictDdbMock } from '../../shared/mocks/dynamodb';
import { makeEmbeddingMock } from '../../shared/mocks/embedding';

const MEMORY_TABLE = 'memory-table';
const KEY = 'key1';
const NS = [...NAMESPACE]; // ['ns']
const SORT_KEY = 'ns#key1'; // `${namespace.join('/')}#${key}`
const VALUE = { data: 'value' };

const BASE_UPDATE_EXPRESSION =
  'SET namespace = :namespace, #key = :key, #value = :value, updatedAt = :updatedAt' +
  ', createdAt = if_not_exists(createdAt, :createdAt)';

// A valid config carrying the required user_id.
const CONFIG = makeRunnableConfig({ userId: USER_ID });

describe('DynamoDBStore', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  /** Construct a store that owns an internally-built (mock-intercepted) client. */
  const makeStore = (
    opts: Partial<ConstructorParameters<typeof DynamoDBStore>[0]> = {},
  ): DynamoDBStore => new DynamoDBStore({ memoryTableName: MEMORY_TABLE, ...opts });

  describe('getUserId enforcement', () => {
    it('rejects with the user_id-required message and issues NO DDB command when config is undefined', async () => {
      const store = makeStore();

      await expect(store.get(NS, KEY)).rejects.toThrow(
        'Field user_id is required in the RunnableConfig for DynamoDBStore.',
      );
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // guards against silently defaulting user_id

    it('rejects when configurable.user_id is missing (empty configurable)', async () => {
      const store = makeStore();

      await expect(
        store.batch([{ namespace: NS, key: KEY }], { configurable: {} }),
      ).rejects.toThrow('Field user_id is required in the RunnableConfig for DynamoDBStore.');
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // guards against treating absent user_id as valid

    it('rejects when configurable.user_id is a non-string value', async () => {
      const store = makeStore();

      await expect(
        store.batch([{ namespace: NS, key: KEY }], {
          configurable: { user_id: 123 as unknown as string },
        }),
      ).rejects.toThrow('Field user_id is required in the RunnableConfig for DynamoDBStore.');
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // guards against accepting numeric/object user_id

    it('rejects when configurable.user_id is an empty string (falsy guard)', async () => {
      const store = makeStore();

      await expect(
        store.batch([{ namespace: NS, key: KEY }], { configurable: { user_id: '' } }),
      ).rejects.toThrow('Field user_id is required in the RunnableConfig for DynamoDBStore.');
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // guards against empty-string user_id slipping through
  });

  describe('batch() validateBatchSize', () => {
    it('rejects an empty operations array before any DDB command', async () => {
      const store = makeStore();

      await expect(store.batch([], CONFIG)).rejects.toThrow(
        'Batch must contain at least one operation',
      );
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // guards against zero-op batches reaching DynamoDB

    it('rejects a batch exceeding the 100-operation maximum before any DDB command', async () => {
      const store = makeStore();
      const ops: GetOperation[] = Array.from({ length: 101 }, () => ({ namespace: NS, key: KEY }));

      await expect(store.batch(ops, CONFIG)).rejects.toThrow(
        'Batch size (101) exceeds maximum of 100 operations',
      );
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // guards against unbounded fan-out
  });

  describe('batch() abort handling', () => {
    it('rejects with the abort reason and issues NO DDB command when config.signal is already aborted', async () => {
      const store = makeStore();
      const reason = new Error('aborted-before-dispatch');
      const signal = preAbortedSignal(reason);

      await expect(store.batch([{ namespace: NS, key: KEY }], { ...CONFIG, signal })).rejects.toBe(
        reason,
      );
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // guards against ignoring RunnableConfig.signal
  });

  describe('batch() operation dispatch', () => {
    it('routes a {namespace,key} op to a GetCommand (get branch)', async () => {
      ddb.mock.on(GetCommand).resolves({
        Item: {
          key: KEY,
          value: VALUE,
          createdAt: FROZEN_NOW_MS,
          updatedAt: FROZEN_NOW_MS,
        },
      });
      const store = makeStore();

      const [item] = await store.batch([{ namespace: NS, key: KEY }] as GetOperation[], CONFIG);

      expectExactGetCommand(ddb.mock, {
        TableName: MEMORY_TABLE,
        Key: { user_id: USER_ID, namespace_key: SORT_KEY },
      });
      expect(item).toEqual({
        key: KEY,
        namespace: NS,
        value: VALUE,
        createdAt: new Date(FROZEN_NOW_MS),
        updatedAt: new Date(FROZEN_NOW_MS),
      });
      expectNoUnexpectedCommands(ddb.mock, [GetCommand]);
    }); // guards against the get branch misrouting

    it('routes a {namespace,key,value} op to an UpdateCommand (put branch)', async () => {
      ddb.mock.on(UpdateCommand).resolves({});
      const store = makeStore();

      await store.batch([{ namespace: NS, key: KEY, value: VALUE }] as PutOperation[], CONFIG);

      expectExactUpdateCommand(ddb.mock, {
        TableName: MEMORY_TABLE,
        Key: { user_id: USER_ID, namespace_key: SORT_KEY },
        UpdateExpression: BASE_UPDATE_EXPRESSION,
        ExpressionAttributeNames: { '#key': 'key', '#value': 'value' },
        ExpressionAttributeValues: {
          ':namespace': 'ns',
          ':key': KEY,
          ':value': VALUE,
          ':updatedAt': FROZEN_NOW_MS,
          ':createdAt': FROZEN_NOW_MS,
        },
      });
      expectNoUnexpectedCommands(ddb.mock, [UpdateCommand]);
    }); // guards against the put branch misrouting

    it('routes a {namespacePrefix,...} op to a QueryCommand (search branch)', async () => {
      ddb.mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });
      const store = makeStore();

      const [results] = await store.batch(
        [{ namespacePrefix: [], limit: 5, offset: 0 }] as SearchOperation[],
        CONFIG,
      );

      expectExactQueryCommand(ddb.mock, {
        TableName: MEMORY_TABLE,
        KeyConditionExpression: 'user_id = :uid',
        ExpressionAttributeValues: { ':uid': USER_ID },
        Limit: 5,
      });
      expect(results).toEqual([]);
      expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
    }); // guards against the search branch misrouting

    it('routes a {limit,offset} op without namespacePrefix/key to a QueryCommand (listNamespaces branch)', async () => {
      ddb.mock.on(QueryCommand).resolves({
        Items: [{ namespace: 'ns' }, { namespace: 'ns/sub' }],
        LastEvaluatedKey: undefined,
      });
      const store = makeStore();

      const [namespaces] = await store.batch(
        [{ limit: 100, offset: 0 }] as ListNamespacesOperation[],
        CONFIG,
      );

      expectExactQueryCommand(ddb.mock, {
        TableName: MEMORY_TABLE,
        KeyConditionExpression: 'user_id = :uid',
        ExpressionAttributeValues: { ':uid': USER_ID },
        ProjectionExpression: 'namespace',
      });
      expect(namespaces).toEqual([['ns'], ['ns', 'sub']]);
      expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
    }); // guards against the listNamespaces branch misrouting

    it('rejects with "Unrecognized operation type at index N" for an op matching no branch', async () => {
      const store = makeStore();
      // No `key`, no `value`, no `namespacePrefix`, and missing `offset` so the
      // listNamespaces guard (limit && offset) does not match either.
      const bogus = { limit: 5 } as unknown as Operation;

      await expect(store.batch([bogus], CONFIG)).rejects.toThrow(
        'Unrecognized operation type at index 0',
      );
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // guards against silently swallowing malformed ops

    it('reports the correct index in the unrecognized-operation error for a later op', async () => {
      ddb.mock.on(GetCommand).resolves({});
      const store = makeStore();
      const ops = [{ namespace: NS, key: KEY }, { limit: 5 }] as unknown as Operation[];

      await expect(store.batch(ops, CONFIG)).rejects.toThrow(
        'Unrecognized operation type at index 1',
      );
    }); // guards against off-by-one in the index reporting

    it('executes a mixed batch in order and returns results positionally', async () => {
      ddb.mock.on(GetCommand).resolves({
        Item: { key: KEY, value: VALUE, createdAt: FROZEN_NOW_MS, updatedAt: FROZEN_NOW_MS },
      });
      ddb.mock.on(UpdateCommand).resolves({});
      const store = makeStore();

      const results = await store.batch(
        [
          { namespace: NS, key: KEY },
          { namespace: NS, key: KEY, value: VALUE },
        ] as Operation[],
        CONFIG,
      );

      expect(results[0]).toEqual({
        key: KEY,
        namespace: NS,
        value: VALUE,
        createdAt: new Date(FROZEN_NOW_MS),
        updatedAt: new Date(FROZEN_NOW_MS),
      });
      expect(results[1]).toBeUndefined(); // put resolves void
      expectExactGetCommand(ddb.mock, {
        TableName: MEMORY_TABLE,
        Key: { user_id: USER_ID, namespace_key: SORT_KEY },
      });
      expectNoUnexpectedCommands(ddb.mock, [GetCommand, UpdateCommand]);
    }); // guards against result-array desync across op types
  });

  // NOTE: The BaseStore public methods (get/put/search/delete/listNamespaces)
  // call `this.batch([...])` with NO RunnableConfig argument, so they cannot
  // supply the `user_id` that batch() requires. Through the public API those
  // methods always reject with the user_id-required error (see "public-method
  // config gap" below). The real success codepath the application drives is
  // `batch(ops, config)`; the result-unwrapping behavior of the public methods
  // is part of the LangGraph base class, not this file's source. We therefore
  // exercise success via batch() and document the public-method config gap.

  describe('public-method config gap (get/put/search/delete/listNamespaces)', () => {
    it('get() rejects with user_id-required because BaseStore.get does not forward a config', async () => {
      const store = makeStore();

      await expect(store.get(NS, KEY)).rejects.toThrow(
        'Field user_id is required in the RunnableConfig for DynamoDBStore.',
      );
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // documents that the public get() has no config seam to pass user_id

    it('search() rejects with user_id-required because BaseStore.search does not forward a config', async () => {
      const store = makeStore();

      await expect(store.search(NS, { limit: 5, offset: 0 })).rejects.toThrow(
        'Field user_id is required in the RunnableConfig for DynamoDBStore.',
      );
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // documents that the public search() has no config seam to pass user_id

    it('delete() rejects with user_id-required because BaseStore.delete does not forward a config', async () => {
      const store = makeStore();

      await expect(store.delete(NS, KEY)).rejects.toThrow(
        'Field user_id is required in the RunnableConfig for DynamoDBStore.',
      );
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // documents that the public delete() has no config seam to pass user_id

    it('listNamespaces() rejects with user_id-required because BaseStore.listNamespaces does not forward a config', async () => {
      const store = makeStore();

      await expect(store.listNamespaces({ limit: 100, offset: 0 })).rejects.toThrow(
        'Field user_id is required in the RunnableConfig for DynamoDBStore.',
      );
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // documents that the public listNamespaces() has no config seam to pass user_id

    it('put() runs BaseStore namespace validation before the user_id check (reserved root rejects)', async () => {
      const store = makeStore();

      // BaseStore.put validates the namespace itself (reserved root label) before batch().
      await expect(store.put(['langgraph'], KEY, VALUE)).rejects.toThrow();
      expectNoUnexpectedCommands(ddb.mock, []);
    }); // guards against a regression that skips base-class namespace validation
  });

  describe('putOperation wiring via batch() (ttl + embedding)', () => {
    it('writes the item with the #ttl alias and computed TTL when ttlDays is configured', async () => {
      ddb.mock.on(UpdateCommand).resolves({});
      const store = makeStore({ ttlDays: 30 });

      await store.batch([{ namespace: NS, key: KEY, value: VALUE }] as PutOperation[], CONFIG);

      expectExactUpdateCommand(ddb.mock, {
        TableName: MEMORY_TABLE,
        Key: { user_id: USER_ID, namespace_key: SORT_KEY },
        UpdateExpression: `SET namespace = :namespace, #key = :key, #value = :value, updatedAt = :updatedAt, #ttl = :ttl, createdAt = if_not_exists(createdAt, :createdAt)`,
        ExpressionAttributeNames: { '#key': 'key', '#value': 'value', '#ttl': 'ttl' },
        ExpressionAttributeValues: {
          ':namespace': 'ns',
          ':key': KEY,
          ':value': VALUE,
          ':updatedAt': FROZEN_NOW_MS,
          ':createdAt': FROZEN_NOW_MS,
          ':ttl': EXPECTED_TTL_30D,
        },
      });
      expectNoUnexpectedCommands(ddb.mock, [UpdateCommand]);
    }); // guards against ttlDays not flowing from constructor into putOperation

    it('embeds the indexed field and persists the embedding when an embedding provider is configured', async () => {
      ddb.mock.on(UpdateCommand).resolves({});
      const embedding = makeEmbeddingMock({ dimensions: 4 });
      const store = makeStore({ embedding });

      await store.batch(
        [
          { namespace: NS, key: KEY, value: { text: 'hello world' }, index: ['text'] },
        ] as PutOperation[],
        CONFIG,
      );

      // makeEmbeddingMock derives a stable vector from the embedded string.
      const expectedVector = await embedding.embedDocuments(['hello world']);
      expectExactUpdateCommand(ddb.mock, {
        TableName: MEMORY_TABLE,
        Key: { user_id: USER_ID, namespace_key: SORT_KEY },
        UpdateExpression: `SET namespace = :namespace, #key = :key, #value = :value, updatedAt = :updatedAt, embedding = :embedding, createdAt = if_not_exists(createdAt, :createdAt)`,
        ExpressionAttributeNames: { '#key': 'key', '#value': 'value' },
        ExpressionAttributeValues: {
          ':namespace': 'ns',
          ':key': KEY,
          ':value': { text: 'hello world' },
          ':updatedAt': FROZEN_NOW_MS,
          ':createdAt': FROZEN_NOW_MS,
          ':embedding': expectedVector,
        },
      });
      expectNoUnexpectedCommands(ddb.mock, [UpdateCommand]);
    }); // guards against the embedding provider not flowing into putOperation
  });

  describe('searchOperation wiring via batch() (fallback flag)', () => {
    it('runs a non-semantic search and returns the mapped SearchItems', async () => {
      ddb.mock.on(QueryCommand).resolves({
        Items: [
          {
            namespace: 'ns',
            key: 'k1',
            value: { a: 1 },
            createdAt: FROZEN_NOW_MS,
            updatedAt: FROZEN_NOW_MS,
          },
        ],
        LastEvaluatedKey: undefined,
      });
      const store = makeStore();

      const [results] = await store.batch(
        [{ namespacePrefix: NS, limit: 5, offset: 0 }] as SearchOperation[],
        CONFIG,
      );

      expectExactQueryCommand(ddb.mock, {
        TableName: MEMORY_TABLE,
        KeyConditionExpression: 'user_id = :uid AND begins_with(namespace_key, :nsp)',
        ExpressionAttributeValues: { ':uid': USER_ID, ':nsp': 'ns' },
        Limit: 5,
      });
      expect(results).toEqual([
        {
          namespace: ['ns'],
          key: 'k1',
          value: { a: 1 },
          createdAt: new Date(FROZEN_NOW_MS),
          updatedAt: new Date(FROZEN_NOW_MS),
          score: undefined,
        },
      ]);
      expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
    }); // guards against a regression in the namespacePrefix -> begins_with wiring

    // Returns the unwrapped first-op result (the SearchItem[]) from batch().
    async function searchWithConfig(store: DynamoDBStore, op: SearchOperation): Promise<unknown[]> {
      const [first] = await store.batch([op] as SearchOperation[], CONFIG);
      return first as unknown[];
    }

    it('FAIL-CLOSED (default): a failing embedQuery propagates and does not fall back to lexical results', async () => {
      ddb.mock.on(QueryCommand).resolves({
        Items: [{ namespace: 'ns', key: 'k1', value: {}, embedding: [[0.1, 0.2, 0.3, 0.4]] }],
        LastEvaluatedKey: undefined,
      });
      const failing = {
        embedDocuments: async () => [[0, 0, 0, 0]],
        embedQuery: async () => {
          throw new Error('embedding service unavailable');
        },
      };
      const store = makeStore({ embedding: failing });

      await expect(
        searchWithConfig(store, { namespacePrefix: [], limit: 5, offset: 0, query: 'q' }),
      ).rejects.toThrow('embedding service unavailable');
    }); // guards against silent degradation when fallback flag defaults to false

    it('FAIL-OPEN: with fallbackToLexicalOnEmbeddingFailure=true a failing embedQuery returns unranked results', async () => {
      ddb.mock.on(QueryCommand).resolves({
        Items: [
          {
            namespace: 'ns',
            key: 'k1',
            value: { a: 1 },
            createdAt: FROZEN_NOW_MS,
            updatedAt: FROZEN_NOW_MS,
            embedding: [[0.1, 0.2, 0.3, 0.4]],
          },
        ],
        LastEvaluatedKey: undefined,
      });
      const failing = {
        embedDocuments: async () => [[0, 0, 0, 0]],
        embedQuery: async () => {
          throw new Error('embedding service unavailable');
        },
      };
      const store = makeStore({
        embedding: failing,
        fallbackToLexicalOnEmbeddingFailure: true,
      });

      const results = (await searchWithConfig(store, {
        namespacePrefix: [],
        limit: 5,
        offset: 0,
        query: 'q',
      })) as Array<{ key: string }>;

      expect(results).toHaveLength(1);
      expect(results[0].key).toBe('k1');
    }); // guards against the fallback flag not flowing from constructor into searchOperation
  });

  describe('listNamespacesOperation wiring via batch()', () => {
    it('returns the sorted, deduped namespace paths from a QueryCommand', async () => {
      ddb.mock.on(QueryCommand).resolves({
        Items: [{ namespace: 'b' }, { namespace: 'a' }, { namespace: 'a' }],
        LastEvaluatedKey: undefined,
      });
      const store = makeStore();

      const [namespaces] = await store.batch(
        [{ limit: 100, offset: 0 }] as ListNamespacesOperation[],
        CONFIG,
      );

      expectExactQueryCommand(ddb.mock, {
        TableName: MEMORY_TABLE,
        KeyConditionExpression: 'user_id = :uid',
        ExpressionAttributeValues: { ':uid': USER_ID },
        ProjectionExpression: 'namespace',
      });
      expect(namespaces).toEqual([['a'], ['b']]);
      expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
    }); // guards against a regression in namespace dedup/sort wiring
  });

  describe('delete path via batch() (value:null)', () => {
    it('issues a DeleteCommand with the composite Key when value is null', async () => {
      ddb.mock.on(DeleteCommand).resolves({});
      const store = makeStore();

      await store.batch([{ namespace: NS, key: KEY, value: null }] as PutOperation[], CONFIG);

      expectExactDeleteCommand(ddb.mock, {
        TableName: MEMORY_TABLE,
        Key: { user_id: USER_ID, namespace_key: SORT_KEY },
      });
      expectNoUnexpectedCommands(ddb.mock, [DeleteCommand]);
    }); // guards against value:null not routing to a DeleteCommand
  });

  describe('destroy()', () => {
    it('destroys the internally-owned underlying DynamoDBClient', () => {
      // Inject a createClient seam is not exposed on the store; instead assert via
      // a spy on the prototype that the owned client's destroy() is invoked.
      const destroySpy = jest.spyOn(DynamoDBClient.prototype, 'destroy');
      const store = makeStore();

      store.destroy();

      expect(destroySpy).toHaveBeenCalledTimes(1);
      destroySpy.mockRestore();
    }); // guards against destroy() leaking an owned client

    it('does NOT destroy an externally-injected client (ownsClient=false branch)', () => {
      const external = DynamoDBDocument.from(new DynamoDBClient({}));
      const destroySpy = jest.spyOn(DynamoDBClient.prototype, 'destroy');
      const store = new DynamoDBStore({ memoryTableName: MEMORY_TABLE, client: external });

      store.destroy();

      expect(destroySpy).not.toHaveBeenCalled();
      destroySpy.mockRestore();
    }); // guards against destroying a shared/borrowed client
  });
});
