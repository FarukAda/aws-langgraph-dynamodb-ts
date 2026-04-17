/**
 * End-to-end DynamoDBStore tests against DynamoDB Local.
 *
 * Focuses on the bits where real DDB semantics differ from the mock:
 * ExpressionAttributeNames/Values round-tripping, begins_with on namespace_key,
 * FilterExpression-vs-KeyCondition ordering, and pagination via
 * ExclusiveStartKey.
 */

import { DynamoDBStore } from '../../src/store';
import {
  assertDdbLocalReachable,
  createAllTables,
  dropAllTables,
  makeLocalClient,
  uniquePrefix,
} from './helpers/ddb-local';

const prefix = uniquePrefix('store');
const { ddb, doc } = makeLocalClient();

let tables: Awaited<ReturnType<typeof createAllTables>>;
let store: DynamoDBStore;

beforeAll(async () => {
  await assertDdbLocalReachable(ddb);
  tables = await createAllTables(ddb, prefix);
  store = new DynamoDBStore({ memoryTableName: tables.memoryTable, client: doc });
});

afterAll(async () => {
  store.destroy();
  await dropAllTables(ddb, tables);
  ddb.destroy();
});

const userConfig = { configurable: { user_id: 'user-int-store' } };

describe('DynamoDBStore against DynamoDB Local', () => {
  it('puts and gets a single item', async () => {
    await store.batch(
      [
        {
          namespace: ['prefs', 'theme'],
          key: 'color',
          value: { hex: '#cafe42', mode: 'dark' },
        },
      ],
      userConfig,
    );

    const [got] = await store.batch([{ namespace: ['prefs', 'theme'], key: 'color' }], userConfig);

    expect(got).toBeTruthy();
    expect((got as any).value).toEqual({ hex: '#cafe42', mode: 'dark' });
  });

  it('searches with namespace prefix and filter operators', async () => {
    const items = [
      { namespace: ['catalog', 'books'], key: 'b1', value: { price: 10, stock: 'in' } },
      { namespace: ['catalog', 'books'], key: 'b2', value: { price: 30, stock: 'out' } },
      { namespace: ['catalog', 'books'], key: 'b3', value: { price: 50, stock: 'in' } },
      { namespace: ['catalog', 'media'], key: 'm1', value: { price: 15, stock: 'in' } },
    ];
    await store.batch(items, userConfig);

    const [hits] = await store.batch(
      [
        {
          namespacePrefix: ['catalog', 'books'],
          filter: {
            // Filter keys are fields inside the stored `value` — the library
            // wraps each as `value.<key>` in the built FilterExpression.
            price: { $gte: 20 },
            stock: { $in: ['in'] },
          },
          limit: 10,
        },
      ],
      userConfig,
    );

    expect(hits as unknown[]).toHaveLength(1);
    const only = (hits as any[])[0];
    expect(only.key).toBe('b3');
    expect(only.value.price).toBe(50);
  });

  it('listNamespaces enumerates distinct paths', async () => {
    await store.batch(
      [
        { namespace: ['tree', 'branch-a'], key: 'k', value: { n: 1 } },
        { namespace: ['tree', 'branch-a', 'leaf'], key: 'k', value: { n: 2 } },
        { namespace: ['tree', 'branch-b'], key: 'k', value: { n: 3 } },
      ],
      userConfig,
    );

    const [namespaces] = await store.batch([{ limit: 100, offset: 0 } as any], userConfig);

    // tree/branch-a, tree/branch-a/leaf, tree/branch-b, plus prior entries from
    // earlier tests in this suite — assert our three are present.
    const flat = (namespaces as string[][]).map((ns) => ns.join('/'));
    expect(flat).toEqual(
      expect.arrayContaining(['tree/branch-a', 'tree/branch-a/leaf', 'tree/branch-b']),
    );
  });
});
