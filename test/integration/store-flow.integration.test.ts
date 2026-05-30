import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

import { DynamoDBStore } from '../../src/index';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from './helpers/ddb-local';
import { FakeEmbeddings } from './helpers/fake-embeddings';

const tableName = 'store-itest';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
let store: DynamoDBStore;

beforeAll(async () => {
  await createTable(admin, tableName);
  store = new DynamoDBStore({
    tableName,
    clientConfig: DDB_LOCAL_CONFIG,
    index: { dims: 8, embeddings: new FakeEmbeddings() as never },
  });
});

afterAll(async () => {
  store.destroy();
  await deleteTable(admin, tableName);
  admin.destroy();
});

describe('DynamoDBStore end-to-end against real DynamoDB', () => {
  it('puts, gets, updates, and deletes an item', async () => {
    await store.put(['users', 'u1'], 'profile', { name: 'Faruk', role: 'admin' });
    const got = await store.get(['users', 'u1'], 'profile');
    expect(got?.value).toEqual({ name: 'Faruk', role: 'admin' });

    await store.put(['users', 'u1'], 'profile', { name: 'Faruk', role: 'owner' });
    expect((await store.get(['users', 'u1'], 'profile'))?.value).toEqual({
      name: 'Faruk',
      role: 'owner',
    });

    await store.delete(['users', 'u1'], 'profile');
    expect(await store.get(['users', 'u1'], 'profile')).toBeNull();
  });

  it('scopes search by namespace prefix and applies metadata filters', async () => {
    await store.put(['docs', 'u1'], 'a', { kind: 'note', score: 1 });
    await store.put(['docs', 'u1'], 'b', { kind: 'note', score: 9 });
    await store.put(['docs', 'u2'], 'c', { kind: 'doc', score: 5 });

    const scoped = await store.search(['docs', 'u1']);
    expect(scoped.map((item) => item.key).sort()).toEqual(['a', 'b']);

    const filtered = await store.search(['docs'], { filter: { score: { $gte: 5 } } });
    expect(filtered.map((item) => item.key).sort()).toEqual(['b', 'c']);
  });

  it('ranks semantic search deterministically with the fake embeddings', async () => {
    await store.put(['memories', 'u9'], 'cats', { text: 'the cat sat on the mat' });
    await store.put(['memories', 'u9'], 'finance', { text: 'quarterly revenue report' });

    const results = await store.search(['memories', 'u9'], { query: 'the cat sat on the mat' });
    expect(results[0].key).toBe('cats');
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score ?? 0);
  });

  it('lists distinct namespaces under a prefix root', async () => {
    await store.put(['team', 't1'], 'k', { v: 1 });
    await store.put(['team', 't2'], 'k', { v: 2 });

    const namespaces = await store.listNamespaces({
      prefix: ['team'],
      limit: 100,
      offset: 0,
    });
    expect(namespaces).toEqual([
      ['team', 't1'],
      ['team', 't2'],
    ]);
  });
});
