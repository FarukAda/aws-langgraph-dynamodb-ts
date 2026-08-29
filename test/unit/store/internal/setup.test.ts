import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import {
  DEFAULT_MAX_SEARCH_CANDIDATES,
  MAX_TOTAL_ITEMS_IN_MEMORY,
} from '../../../../src/shared/constants';
import { setUpStore } from '../../../../src/store/internal/setup';

describe('setUpStore', () => {
  it('defaults to the JSON serializer and owns a built client', () => {
    const fake = { destroy: jest.fn(), config: {}, middlewareStack: {}, send: jest.fn() };
    const setup = setUpStore({
      tableName: 'store',
      clientConfig: { region: 'us-east-1' },
      createClient: () => fake as never,
    });
    expect(setup.ownsClient).toBe(true);
    expect(setup.context.serde).toBe(JSON_SERDE);
    expect(setup.context.tableName).toBe('store');
    expect(setup.context.maxSearchCandidates).toBe(DEFAULT_MAX_SEARCH_CANDIDATES);
    expect(setup.context.vectorBackend).toBeUndefined();
  });

  it('carries an explicit vector backend and search-candidate cap', () => {
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    const setup = setUpStore({
      tableName: 'store',
      client: { send: jest.fn() } as never,
      index: { dims: 3, embeddings: { embedQuery: async () => [0] } as never },
      vectorBackend: vectorBackend as never,
      maxSearchCandidates: 50,
    });
    expect(setup.context.vectorBackend).toBe(vectorBackend);
    expect(setup.context.maxSearchCandidates).toBe(50);
  });

  it('rejects a vectorBackend configured without an index (I2)', () => {
    // With `index` unset, every put computed no embedding and instructed the
    // backend to *delete* the item's vector, and search() silently fell
    // through to an unranked scan-order listing with no .score field — a
    // semantic query returning a normal-looking but meaningless response.
    // reconcileVectorIndex already guarded this exact misconfiguration.
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    expect(() =>
      setUpStore({
        tableName: 'store',
        client: { send: jest.fn() } as never,
        vectorBackend: vectorBackend as never,
      }),
    ).toThrow(/vectorBackend requires a configured `index`/);
  });

  it('does not own an injected client and carries index/compression/ttl', () => {
    const index = { dims: 3, embeddings: { embedQuery: async () => [0] } as never };
    const setup = setUpStore({
      tableName: 'store',
      client: { send: jest.fn() } as never,
      compression: { enabled: true },
      ttl: { days: 1 },
      index,
      s3: { bucketName: 'b' },
    });
    expect(setup.ownsClient).toBe(false);
    expect(setup.context.compression).toEqual({ enabled: true });
    expect(setup.context.ttl).toEqual({ days: 1 });
    expect(setup.context.index).toBe(index);
    expect(setup.context.offloader).toBeDefined();
  });

  it('defaults the S3 key prefix to an adapter-scoped segment, but honors an explicit override', () => {
    const defaulted = setUpStore({
      tableName: 'store',
      client: { send: jest.fn() } as never,
      s3: { bucketName: 'b' },
    });
    expect(defaulted.context.offloader?.getKeyPrefix()).toBe('langgraph-checkpoints/store/');

    const overridden = setUpStore({
      tableName: 'store',
      client: { send: jest.fn() } as never,
      s3: { bucketName: 'b', keyPrefix: 'custom/' },
    });
    expect(overridden.context.offloader?.getKeyPrefix()).toBe('custom/');
  });

  it('defaults maxScanItems to the shared in-memory cap, but accepts an override', () => {
    const defaulted = setUpStore({ tableName: 'store', client: { send: jest.fn() } as never });
    expect(defaulted.context.maxScanItems).toBe(MAX_TOTAL_ITEMS_IN_MEMORY);

    const overridden = setUpStore({
      tableName: 'store',
      client: { send: jest.fn() } as never,
      maxScanItems: 50_000,
    });
    expect(overridden.context.maxScanItems).toBe(50_000);
  });
});

describe('index configuration validation (F6)', () => {
  const base = {
    tableName: 'store',
    clientConfig: { region: 'us-east-1' },
    createClient: () =>
      ({ destroy: jest.fn(), config: {}, middlewareStack: {}, send: jest.fn() }) as never,
  };

  it('rejects an index with no embeddings, instead of a TypeError at first use', () => {
    expect(() => setUpStore({ ...base, index: { dims: 1024 } } as never)).toThrow(
      /index\.embeddings/,
    );
    expect(() => setUpStore({ ...base, index: { dims: 1024 } } as never)).toThrow(
      expect.objectContaining({ name: 'ValidationError' }),
    );
  });

  it('rejects an index whose embeddings cannot embedQuery', () => {
    expect(() => setUpStore({ ...base, index: { dims: 1, embeddings: {} } } as never)).toThrow(
      /embedQuery/,
    );
  });

  it('accepts an index that can embed, and does not require dims to be read', () => {
    const embeddings = { embedQuery: async () => [1, 2, 3] };
    expect(() => setUpStore({ ...base, index: { dims: 3, embeddings } } as never)).not.toThrow();
  });

  it('still rejects a vectorBackend with no index at all', () => {
    const backend = { upsert: async () => {}, query: async () => [], delete: async () => {} };
    expect(() => setUpStore({ ...base, vectorBackend: backend } as never)).toThrow(
      /vectorBackend requires a configured `index`/,
    );
  });

  it('rejects an unrecognised vectorScoreDirection rather than ranking by it', () => {
    // toRelevanceScores treats anything it does not recognise as a no-op, so a
    // wrong string would otherwise leave a distance backend ranked backwards
    // with no error and no warn. Same premise as the index guard above:
    // JavaScript callers pass shapes the type cannot enforce.
    expect(() => setUpStore({ ...base, vectorScoreDirection: 'Distance' } as never)).toThrow(
      /vectorScoreDirection/,
    );
    expect(() => setUpStore({ ...base, vectorScoreDirection: 'nearest' } as never)).toThrow(
      expect.objectContaining({ name: 'ValidationError' }),
    );
  });

  it('accepts both declared score directions, and defaults to relevance', () => {
    expect(setUpStore({ ...base } as never).context.vectorScoreDirection).toBe('relevance');
    expect(
      setUpStore({ ...base, vectorScoreDirection: 'distance' } as never).context
        .vectorScoreDirection,
    ).toBe('distance');
  });
});
