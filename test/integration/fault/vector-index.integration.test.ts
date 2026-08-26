import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

import { DynamoDBStore, type VectorBackend, type VectorRef } from '../../../src/index';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from '../helpers/ddb-local';
import { FakeEmbeddings } from '../helpers/fake-embeddings';

const REF_SEPARATOR = ' ';

/** In-memory VectorBackend whose next upsert or delete can be made to fail, to drive the self-heal path. */
class FlakyMemoryBackend implements VectorBackend {
  readonly vectors = new Map<string, VectorRef>();
  failNextUpsert = false;
  failNextDelete = false;

  private id(namespace: string[], key: string): string {
    return `${namespace.join(REF_SEPARATOR)}${REF_SEPARATOR}${key}`;
  }

  async upsert(namespace: string[], key: string): Promise<void> {
    if (this.failNextUpsert) {
      this.failNextUpsert = false;
      throw new Error('backend upsert unavailable');
    }
    this.vectors.set(this.id(namespace, key), { namespace, key });
  }

  async query(): Promise<never[]> {
    return [];
  }

  async delete(namespace: string[], key: string): Promise<void> {
    if (this.failNextDelete) {
      this.failNextDelete = false;
      throw new Error('backend delete unavailable');
    }
    this.vectors.delete(this.id(namespace, key));
  }

  async listKeys(prefix: string[]): Promise<VectorRef[]> {
    const head = prefix.join(REF_SEPARATOR);
    return [...this.vectors.values()].filter((ref) =>
      ref.namespace.join(REF_SEPARATOR).startsWith(head),
    );
  }
}

const tableName = 'vector-index-fault-itest';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
const backend = new FlakyMemoryBackend();
let store: DynamoDBStore;

beforeAll(async () => {
  await createTable(admin, tableName);
  store = new DynamoDBStore({
    tableName,
    clientConfig: DDB_LOCAL_CONFIG,
    index: { dims: 8, embeddings: new FakeEmbeddings() as never },
    vectorBackend: backend,
  });
});

afterAll(async () => {
  store.destroy();
  await deleteTable(admin, tableName);
  admin.destroy();
});

describe('vector index self-heal + reconcile against real DynamoDB', () => {
  it('keeps the canonical item when the backend upsert fails, then reconcile repairs it', async () => {
    backend.failNextUpsert = true;
    await store.put(['mem', 'u1'], 'a', { text: 'hello world' });

    expect((await store.get(['mem', 'u1'], 'a'))?.value).toEqual({ text: 'hello world' });
    expect(backend.vectors.size).toBe(0);

    const repaired = await store.reconcileVectorIndex(['mem', 'u1']);
    expect(repaired).toEqual({ upserted: 1, pruned: 0 });
    expect(backend.vectors.size).toBe(1);
  });

  it('prunes a backend vector that has no canonical item', async () => {
    backend.vectors.set('mem u1 stale', { namespace: ['mem', 'u1'], key: 'stale' });

    const result = await store.reconcileVectorIndex(['mem', 'u1']);

    expect(result.pruned).toBe(1);
    expect(backend.vectors.has('mem u1 stale')).toBe(false);
    expect(backend.vectors.has('mem u1 a')).toBe(true);
  });

  it('prunes a backend vector whose item drifted to having no embedding (indexable text became empty)', async () => {
    const driftBackend = new FlakyMemoryBackend();
    const driftStore = new DynamoDBStore({
      tableName,
      clientConfig: DDB_LOCAL_CONFIG,
      index: { dims: 8, embeddings: new FakeEmbeddings() as never, fields: ['text'] },
      vectorBackend: driftBackend,
    });
    await driftStore.put(['drift', 'u1'], 'shrinking', { text: 'hello world' });
    await driftStore.reconcileVectorIndex(['drift', 'u1']);
    expect(driftBackend.vectors.has('drift u1 shrinking')).toBe(true);

    // The 'text' field is now missing entirely, so extractText yields an empty
    // string and embedValue returns undefined for this item. put() itself
    // would normally self-heal by syncing that undefined embedding as a
    // delete — fail that one sync call (mirroring syncVectorIndex's own
    // swallow-and-let-reconcile-repair contract) so the stale vector survives
    // to actually exercise reconcile's prune path instead of never reaching it.
    driftBackend.failNextDelete = true;
    await driftStore.put(['drift', 'u1'], 'shrinking', { other: 'value' });
    expect(driftBackend.vectors.has('drift u1 shrinking')).toBe(true);

    const result = await driftStore.reconcileVectorIndex(['drift', 'u1']);
    driftStore.destroy();

    // Pre-fix, this embedding-less item still counted as "live" in
    // selectOrphans, so its now-stale backend vector was never pruned.
    expect(result.pruned).toBe(1);
    expect(driftBackend.vectors.has('drift u1 shrinking')).toBe(false);
  });
});
