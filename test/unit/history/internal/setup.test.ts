import { setUpHistory } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';

describe('setUpHistory', () => {
  it('rejects an invalid tableName and an unknown corrupt-message policy at construction (CORE-05)', () => {
    const client = { send: jest.fn() } as never;
    expect(() => setUpHistory({ tableName: 'bad name', client })).toThrow(/tableName/);
    expect(() =>
      setUpHistory({ tableName: 'history', client, onCorruptMessage: 'ignore' as never }),
    ).toThrow(/onCorruptMessage/);
  });

  it('defaults to the JSON serializer and owns a built client', () => {
    const fake = { destroy: jest.fn(), config: {}, middlewareStack: {}, send: jest.fn() };
    const setup = setUpHistory({
      tableName: 'history',
      clientConfig: { region: 'us-east-1' },
      createClient: () => fake as never,
    });
    expect(setup.ownsClient).toBe(true);
    expect(setup.context.serde).toBe(JSON_SERDE);
    expect(setup.context.offloader).toBeUndefined();
    expect(typeof setup.context.ulid()).toBe('string');
  });

  it('does not own an injected client and builds an offloader + ttl/compression', () => {
    const setup = setUpHistory({
      tableName: 'history',
      client: { send: jest.fn() } as never,
      s3: { bucketName: 'b' },
      compression: { enabled: true },
      ttl: { days: 1 },
      serde: JSON_SERDE,
    });
    expect(setup.ownsClient).toBe(false);
    expect(setup.context.offloader).toBeDefined();
    expect(setup.context.compression).toEqual({ enabled: true });
    expect(setup.context.ttl).toEqual({ days: 1 });
  });

  it('defaults the S3 key prefix to an adapter-scoped segment, but honors an explicit override', () => {
    const defaulted = setUpHistory({
      tableName: 'history',
      client: { send: jest.fn() } as never,
      s3: { bucketName: 'b' },
    });
    expect(defaulted.context.offloader?.getKeyPrefix()).toBe('langgraph-checkpoints/history/');

    const overridden = setUpHistory({
      tableName: 'history',
      client: { send: jest.fn() } as never,
      s3: { bucketName: 'b', keyPrefix: 'custom/' },
    });
    expect(overridden.context.offloader?.getKeyPrefix()).toBe('custom/');
  });
});

describe('S3 region inheritance (CODEC-15)', () => {
  it('builds the S3 client in the DynamoDB region when s3.clientConfig names none', async () => {
    let seen: { region?: unknown } | undefined;
    const ddb = {
      destroy: jest.fn(),
      config: {},
      middlewareStack: { clone: () => ({}) },
      send: jest.fn(),
    };
    const s3Client = {
      destroy: jest.fn(),
      send: jest.fn(async () => ({})),
      config: {},
      middlewareStack: { clone: () => ({}) },
    };
    const setup = setUpHistory({
      tableName: 'hist',
      clientConfig: { region: 'eu-central-1' },
      createClient: () => ddb as never,
      s3: {
        bucketName: 'b',
        createS3Client: (config) => {
          seen = config;
          return s3Client as never;
        },
      },
    });
    await setup.context.offloader?.deleteBatch([]);
    expect(seen).toMatchObject({ region: 'eu-central-1' });
    setup.context.offloader?.destroy();
  });
});

describe('retry policy (DDB-03)', () => {
  it('resolves the retry policy onto the context, defaulting to five attempts', () => {
    const client = { send: jest.fn() } as never;
    expect(setUpHistory({ tableName: 't123', client }).context.retry?.maxAttempts).toBe(5);
    expect(
      setUpHistory({ tableName: 't123', client, retry: { maxAttempts: 2, baseDelayMs: 1 } }).context
        .retry,
    ).toMatchObject({ maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5000 });
  });
});
