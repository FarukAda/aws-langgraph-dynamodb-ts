import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

import {
  DynamoDBStore,
  ResultTruncatedError,
  type VectorBackend,
  type VectorMatch,
} from '../../src/index';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from './helpers/ddb-local';
import { FakeEmbeddings } from './helpers/fake-embeddings';

/** In-memory VectorBackend that returns upserted entries in insertion order, honoring topK. */
class OrderedMemoryBackend implements VectorBackend {
  private entries: { namespace: string[]; key: string }[] = [];

  async upsert(namespace: string[], key: string): Promise<void> {
    this.entries.push({ namespace, key });
  }

  async query(_namespace: string[], _vector: number[], topK: number): Promise<VectorMatch[]> {
    return this.entries.slice(0, topK).map((entry) => ({ ...entry, score: 1 }));
  }

  async delete(namespace: string[], key: string): Promise<void> {
    this.entries = this.entries.filter(
      (entry) => !(entry.namespace.join('/') === namespace.join('/') && entry.key === key),
    );
  }
}

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

  it('filters with $in and $nin operators', async () => {
    await store.put(['filter-ops', 'u1'], 'a', { status: 'active' });
    await store.put(['filter-ops', 'u1'], 'b', { status: 'archived' });
    await store.put(['filter-ops', 'u1'], 'c', { status: 'pending' });

    const inResults = await store.search(['filter-ops', 'u1'], {
      filter: { status: { $in: ['active', 'pending'] } },
    });
    expect(inResults.map((item) => item.key).sort()).toEqual(['a', 'c']);

    const ninResults = await store.search(['filter-ops', 'u1'], {
      filter: { status: { $nin: ['archived'] } },
    });
    expect(ninResults.map((item) => item.key).sort()).toEqual(['a', 'c']);
  });

  it('refills from the vector backend when candidates are filtered out, instead of under-returning', async () => {
    const backend = new OrderedMemoryBackend();
    const vectorStore = new DynamoDBStore({
      tableName,
      clientConfig: DDB_LOCAL_CONFIG,
      index: { dims: 8, embeddings: new FakeEmbeddings() as never },
      vectorBackend: backend,
    });
    // Inserted in this order so a small initial topK only sees the two
    // inactive items first; the refill loop must grow topK to reach 'active-1'.
    await vectorStore.put(['refill', 'u1'], 'inactive-1', { status: 'inactive' });
    await vectorStore.put(['refill', 'u1'], 'inactive-2', { status: 'inactive' });
    await vectorStore.put(['refill', 'u1'], 'active-1', { status: 'active' });

    const results = await vectorStore.search(['refill', 'u1'], {
      query: 'anything',
      limit: 1,
      filter: { status: 'active' },
    });
    vectorStore.destroy();
    expect(results.map((item) => item.key)).toEqual(['active-1']);
  });

  it('throws ResultTruncatedError when a plain search exceeds maxScanItems, and succeeds once raised', async () => {
    const cappedStore = new DynamoDBStore({
      tableName,
      clientConfig: DDB_LOCAL_CONFIG,
      maxScanItems: 2,
    });
    await cappedStore.put(['cap-test', 'u1'], 'a', { v: 1 });
    await cappedStore.put(['cap-test', 'u1'], 'b', { v: 2 });
    await cappedStore.put(['cap-test', 'u1'], 'c', { v: 3 });

    await expect(cappedStore.search(['cap-test', 'u1'])).rejects.toThrow(ResultTruncatedError);
    cappedStore.destroy();

    const uncappedStore = new DynamoDBStore({
      tableName,
      clientConfig: DDB_LOCAL_CONFIG,
      maxScanItems: 10,
    });
    const results = await uncappedStore.search(['cap-test', 'u1']);
    uncappedStore.destroy();
    expect(results.map((item) => item.key).sort()).toEqual(['a', 'b', 'c']);
  });
});
