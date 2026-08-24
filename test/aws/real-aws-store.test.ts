import { randomUUID } from 'node:crypto';

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import type { EmbeddingsInterface } from '@langchain/core/embeddings';
import { AsyncCaller } from '@langchain/core/utils/async_caller';

import { DynamoDBStore, type VectorBackend, type VectorRef } from '../../src/index';

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
const clientConfig = region ? { region } : {};
const tableName = `aws-langgraph-storetest-${randomUUID()}`;
const REF_SEPARATOR = ' ';
const EMBED_DIMS = 8;

/** Deterministic offline embedding, enough to exercise the index code paths. */
class DeterministicEmbeddings implements EmbeddingsInterface {
  caller = new AsyncCaller({});

  async embedQuery(text: string): Promise<number[]> {
    const vector = new Array(EMBED_DIMS).fill(0);
    for (const char of text.toLowerCase()) {
      vector[char.charCodeAt(0) % EMBED_DIMS] += 1;
    }
    return vector;
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.embedQuery(text)));
  }
}

/** In-memory VectorBackend whose first upsert fails, to drive the self-heal path. */
class FlakyMemoryBackend implements VectorBackend {
  readonly vectors = new Map<string, VectorRef>();
  failNextUpsert = false;

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
    this.vectors.delete(this.id(namespace, key));
  }

  async listKeys(prefix: string[]): Promise<VectorRef[]> {
    const head = prefix.join(REF_SEPARATOR);
    return [...this.vectors.values()].filter((ref) =>
      ref.namespace.join(REF_SEPARATOR).startsWith(head),
    );
  }
}

/**
 * Real-AWS verification of the store's vector-index consistency feature: the
 * best-effort sync on `put` and `reconcileVectorIndex` (re-push + prune) run
 * against a real DynamoDB table, exercising the real Query enumeration and
 * consistent-read paths that unit mocks and DynamoDB Local cannot fully prove.
 */
describe('DynamoDBStore vector-index consistency against real AWS', () => {
  let admin: DynamoDBClient;
  const backend = new FlakyMemoryBackend();
  let store: DynamoDBStore;

  beforeAll(async () => {
    admin = new DynamoDBClient(clientConfig);
    await admin.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
    await waitUntilTableExists({ client: admin, maxWaitTime: 90 }, { TableName: tableName });
    store = new DynamoDBStore({
      tableName,
      clientConfig,
      index: { dims: EMBED_DIMS, embeddings: new DeterministicEmbeddings() },
      vectorBackend: backend,
    });
  });

  afterAll(async () => {
    store?.destroy();
    if (admin) {
      await admin.send(new DeleteTableCommand({ TableName: tableName }));
      await waitUntilTableNotExists({ client: admin, maxWaitTime: 90 }, { TableName: tableName });
      admin.destroy();
    }
  });

  it('keeps the canonical item when the backend upsert fails', async () => {
    backend.failNextUpsert = true;
    await store.put(['mem', 'u1'], 'a', { text: 'hello world' });

    expect((await store.get(['mem', 'u1'], 'a'))?.value).toEqual({ text: 'hello world' });
    expect(backend.vectors.size).toBe(0);
  });

  it('reconcileVectorIndex re-pushes live embeddings from the real table', async () => {
    await store.put(['mem', 'u1'], 'b', { text: 'second item' });

    const result = await store.reconcileVectorIndex(['mem', 'u1']);

    expect(result).toEqual({ upserted: 2, pruned: 0 });
    expect(backend.vectors.has('mem u1 a')).toBe(true);
    expect(backend.vectors.has('mem u1 b')).toBe(true);
  });

  it('reconcileVectorIndex prunes a backend vector with no canonical item', async () => {
    backend.vectors.set('mem u1 stale', { namespace: ['mem', 'u1'], key: 'stale' });

    const result = await store.reconcileVectorIndex(['mem', 'u1']);

    expect(result.pruned).toBe(1);
    expect(backend.vectors.has('mem u1 stale')).toBe(false);
    expect(backend.vectors.has('mem u1 a')).toBe(true);
    expect(backend.vectors.has('mem u1 b')).toBe(true);
  });
});
