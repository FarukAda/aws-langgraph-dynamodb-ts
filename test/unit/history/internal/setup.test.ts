import { setUpHistory } from '../../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { fakeClientMethods, fakeMiddlewareStack } from '../../../shared/helpers/ddb-mock';

describe('setUpHistory', () => {
  it('rejects an option key this package does not read', () => {
    expect(() => setUpHistory({ tableName: 'tbl', readConcurency: 4 } as never)).toThrow(
      expect.objectContaining({
        code: 'VALIDATION',
        context: { field: 'options.readConcurency' },
      }),
    );
  });

  it('rejects an invalid tableName and an unknown corrupt-message policy at construction', () => {
    const client = { send: jest.fn() } as never;
    expect(() => setUpHistory({ tableName: 'bad name', client })).toThrow(/tableName/);
    expect(() =>
      setUpHistory({ tableName: 'history', client, onCorruptMessage: 'ignore' as never }),
    ).toThrow(/onCorruptMessage/);
  });

  it('defaults to the JSON serializer and owns a built client', () => {
    const fake = {
      destroy: jest.fn(),
      config: {},
      middlewareStack: fakeMiddlewareStack(),
      send: jest.fn(),
    };
    const setup = setUpHistory({
      tableName: 'history',
      clientConfig: { region: 'us-east-1' },
      createClient: () => fake as never,
    });
    setup.shell.release();
    expect(fake.destroy).toHaveBeenCalledTimes(1);
    expect(setup.context.serde).toBe(JSON_SERDE);
    expect(setup.context.offloader).toBeUndefined();
    expect(typeof setup.context.ulid()).toBe('string');
  });

  it('does not own an injected client and builds an offloader + ttl/compression', () => {
    const client = { ...fakeClientMethods(), destroy: jest.fn() };
    const setup = setUpHistory({
      tableName: 'history',
      client,
      s3: { bucketName: 'b' },
      compression: { enabled: true },
      ttl: { days: 1 },
      serde: JSON_SERDE,
    });
    setup.shell.release();
    expect(client.destroy).not.toHaveBeenCalled();
    expect(setup.context.offloader).toBeDefined();
    expect(setup.context.compression).toEqual({ enabled: true });
    expect(setup.context.ttl).toEqual({ days: 1 });
  });

  it('defaults the S3 key prefix to an adapter-scoped segment, but honors an explicit override', () => {
    const defaulted = setUpHistory({
      tableName: 'history',
      client: fakeClientMethods(),
      s3: { bucketName: 'b' },
    });
    expect(defaulted.context.offloader?.getKeyPrefix()).toBe('langgraph-checkpoints/history/');

    const overridden = setUpHistory({
      tableName: 'history',
      client: fakeClientMethods(),
      s3: { bucketName: 'b', keyPrefix: 'custom/' },
    });
    expect(overridden.context.offloader?.getKeyPrefix()).toBe('custom/');
  });
});

describe('collaborator shape', () => {
  it('refuses an injected client missing a method this package calls', () => {
    expect(() =>
      setUpHistory({ tableName: 'history', client: { send: jest.fn() } as never }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION', context: { field: 'client.get' } }));
  });

  it('refuses a logger missing a level this package calls', () => {
    expect(() =>
      setUpHistory({
        tableName: 'history',
        client: fakeClientMethods(),
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
      }),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION', context: { field: 'logger.debug' } }));
  });

  it('refuses a serde missing a method this package calls', () => {
    expect(() =>
      setUpHistory({
        tableName: 'history',
        client: fakeClientMethods(),
        serde: {
          dumpsTyped: () => Promise.resolve(['json', new Uint8Array()]),
        } as never,
      }),
    ).toThrow(
      expect.objectContaining({ code: 'VALIDATION', context: { field: 'serde.loadsTyped' } }),
    );
  });
});

describe('S3 region inheritance', () => {
  it('builds the S3 client in the DynamoDB region when s3.clientConfig names none', async () => {
    let seen: { region?: unknown } | undefined;
    const ddb = {
      destroy: jest.fn(),
      config: {},
      middlewareStack: fakeMiddlewareStack(),
      send: jest.fn(),
    };
    const s3Client = {
      destroy: jest.fn(),
      send: jest.fn(() => ({})),
      config: {},
      middlewareStack: fakeMiddlewareStack(),
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

describe('retry policy', () => {
  it('resolves the retry policy onto the context, defaulting to five attempts', () => {
    const client = fakeClientMethods() as never;
    expect(setUpHistory({ tableName: 't123', client }).context.retry?.maxAttempts).toBe(5);
    expect(
      setUpHistory({ tableName: 't123', client, retry: { maxAttempts: 2, baseDelayMs: 1 } }).context
        .retry,
    ).toMatchObject({ maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5000 });
  });
});
