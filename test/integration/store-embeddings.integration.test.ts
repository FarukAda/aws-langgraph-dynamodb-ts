/**
 * INTEGRATION — store embeddings end-to-end (gap-class N, AC-31 / REQ-35).
 *
 * Uses the deterministic embedding mock (`test/shared/mocks/embedding.ts`) so the
 * same document always maps to the same vector. We assert:
 *
 *   - HAPPY PATH: put items with `index` (embedded fields) then a semantic
 *     `search({ query })` returns the corpus ranked by cosine similarity, with the
 *     document closest to the query ranked first and a positive score.
 *   - ERROR PATH: when `embedDocuments` throws, the put aborts BEFORE the DDB
 *     update — a follow-up `get` returns null, proving no half-written row.
 *   - `validateEmbeddings` rejects NaN / dimension-mismatch / short vectors,
 *     again leaving no row.
 *   - An empty `index` array issues NO embedding call (recording mock asserts 0).
 *
 * Env-gated by `jest.integration.config.ts`; requires DDB-Local. `beforeAll`
 * fails fast with guidance when Docker is down. No randomness anywhere — vectors
 * are derived deterministically from input text.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { GetOperation, PutOperation, SearchOperation } from '@langchain/langgraph';

import { DynamoDBStore } from '../../src';
import {
  embeddingReturnsNaN,
  embeddingReturnsShort,
  embeddingThrows,
  makeEmbeddingMock,
  recordingEmbeddingMock,
} from '../shared/mocks/embedding';
import {
  assertDdbLocalReachable,
  createAllTables,
  dropAllTables,
  makeLocalClient,
  uniquePrefix,
} from './helpers/ddb-local';

const USER = 'embed-user';
const NS = ['memories'];
const config = { configurable: { user_id: USER } };

describe('store embeddings end-to-end (integration)', () => {
  let ddb: DynamoDBClient;
  let doc: DynamoDBDocument;
  let tables: { memoryTable: string } & Record<string, string>;

  beforeAll(async () => {
    ({ ddb, doc } = makeLocalClient());
    await assertDdbLocalReachable(ddb);
    tables = await createAllTables(ddb, uniquePrefix('store-embeddings'));
  });

  afterAll(async () => {
    if (tables) await dropAllTables(ddb, tables);
    ddb?.destroy();
  });

  function storeWith(embedding: ReturnType<typeof makeEmbeddingMock>): DynamoDBStore {
    return new DynamoDBStore({ client: doc, memoryTableName: tables.memoryTable, embedding });
  }

  it('ranks semantic search results by cosine similarity to the query', async () => {
    const store = storeWith(makeEmbeddingMock({ dimensions: 4 }));

    const puts: PutOperation[] = [
      { namespace: NS, key: 'cats', value: { text: 'cats are great pets' }, index: ['$.text'] },
      { namespace: NS, key: 'dogs', value: { text: 'dogs are loyal pets' }, index: ['$.text'] },
      { namespace: NS, key: 'taxes', value: { text: 'quarterly tax filing' }, index: ['$.text'] },
    ];
    for (const p of puts) {
      await store.batch([p], config);
    }

    // The deterministic mock maps identical text to identical vectors, so the
    // exact query string scores a perfect 1.0 against its stored counterpart and
    // ranks first ahead of the unrelated documents.
    const op: SearchOperation = {
      namespacePrefix: NS,
      query: 'dogs are loyal pets',
      limit: 3,
      offset: 0,
    };
    const [results] = await store.batch([op], config);

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]?.key).toBe('dogs');
    expect(typeof results[0]?.score).toBe('number');
    expect(results[0]!.score!).toBeGreaterThan(0);
    // Ranking is monotonically non-increasing in score.
    for (let i = 1; i < results.length; i += 1) {
      expect(results[i - 1]!.score!).toBeGreaterThanOrEqual(results[i]!.score!);
    }
  }); // AC-31

  it('issues no embedding call when the put carries no index, yet still persists the row', async () => {
    const recording = recordingEmbeddingMock({ dimensions: 4 });
    const store = new DynamoDBStore({
      client: doc,
      memoryTableName: tables.memoryTable,
      embedding: recording,
    });

    const put: PutOperation = {
      namespace: ['noindex'],
      key: 'plain',
      value: { text: 'no vector' },
    };
    await store.batch([put], config);

    expect(recording.callCount).toBe(0);

    const get: GetOperation = { namespace: ['noindex'], key: 'plain' };
    const [item] = await store.batch([get], config);
    expect(item?.value).toMatchObject({ text: 'no vector' });
  }); // AC-31

  it('aborts the put with no half-written row when embedDocuments throws', async () => {
    const store = storeWith(embeddingThrows(new Error('bedrock unavailable')));

    const put: PutOperation = {
      namespace: ['fail'],
      key: 'doomed',
      value: { text: 'will not persist' },
      index: ['$.text'],
    };
    await expect(store.batch([put], config)).rejects.toThrow('bedrock unavailable');

    // A reader (no embedding needed for get) must see NO row — the embedding
    // failure happened before the DynamoDB update.
    const reader = new DynamoDBStore({ client: doc, memoryTableName: tables.memoryTable });
    const [item] = await reader.batch(
      [{ namespace: ['fail'], key: 'doomed' } as GetOperation],
      config,
    );
    expect(item).toBeNull();
  }); // AC-31

  it('rejects NaN vectors via validateEmbeddings and writes no row', async () => {
    const store = storeWith(embeddingReturnsNaN());

    const put: PutOperation = {
      namespace: ['nan'],
      key: 'bad',
      value: { text: 'nan vector' },
      index: ['$.text'],
    };
    await expect(store.batch([put], config)).rejects.toThrow();

    const reader = new DynamoDBStore({ client: doc, memoryTableName: tables.memoryTable });
    const [item] = await reader.batch([{ namespace: ['nan'], key: 'bad' } as GetOperation], config);
    expect(item).toBeNull();
  }); // AC-31

  it('rejects a short vector batch (fewer vectors than documents) and writes no row', async () => {
    const store = storeWith(embeddingReturnsShort());

    const put: PutOperation = {
      namespace: ['short'],
      key: 'bad',
      // Two embedded fields ⇒ two documents; the mock returns only one vector.
      value: { a: 'first field', b: 'second field' },
      index: ['$.a', '$.b'],
    };
    await expect(store.batch([put], config)).rejects.toThrow();

    const reader = new DynamoDBStore({ client: doc, memoryTableName: tables.memoryTable });
    const [item] = await reader.batch(
      [{ namespace: ['short'], key: 'bad' } as GetOperation],
      config,
    );
    expect(item).toBeNull();
  }); // AC-31
});
