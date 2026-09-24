import { setUpCheckpointer } from '../../../../src/checkpointer/internal/setup';
import { DynamoDBSaver } from '../../../../src/checkpointer/saver';
import { fakeClientMethods, fakeMiddlewareStack } from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: (): Promise<[string, Uint8Array]> => Promise.resolve(['json', new Uint8Array()]),
  loadsTyped: (): Promise<unknown> => Promise.resolve({}),
};

describe('setUpCheckpointer', () => {
  it('rejects an option key this package does not read', () => {
    expect(() => new DynamoDBSaver({ tableName: 'tbl', readConcurency: 4 } as never)).toThrow(
      expect.objectContaining({
        code: 'VALIDATION',
        context: { field: 'options.readConcurency' },
      }),
    );
  });

  it('rejects an invalid tableName and an ambiguous client configuration at construction (CORE-05)', () => {
    expect(() =>
      setUpCheckpointer({ tableName: 'bad name', client: { send: jest.fn() } as never }, serde),
    ).toThrow(/tableName/);
    expect(() =>
      setUpCheckpointer(
        { tableName: 'ckpt', client: { send: jest.fn() } as never, clientConfig: { region: 'x' } },
        serde,
      ),
    ).toThrow(/client/);
  });

  it('builds and owns a client from clientConfig and exposes the context', () => {
    const fakeClient = {
      destroy: jest.fn(),
      config: {},
      middlewareStack: fakeMiddlewareStack(),
      send: jest.fn(),
    };
    const setup = setUpCheckpointer(
      {
        tableName: 'ckpt',
        clientConfig: { region: 'us-east-1' },
        createClient: () => fakeClient as never,
      },
      serde,
    );
    setup.shell.release();
    expect(fakeClient.destroy).toHaveBeenCalledTimes(1);
    expect(setup.context.tableName).toBe('ckpt');
    expect(setup.context.serde).toBe(serde);
    expect(setup.context.offloader).toBeUndefined();
  });

  it('does not own an injected client', () => {
    const injected = { ...fakeClientMethods(), send: jest.fn(), destroy: jest.fn() };
    const setup = setUpCheckpointer({ tableName: 'ckpt', client: injected }, serde);
    setup.shell.release();
    expect(injected.destroy).not.toHaveBeenCalled();
    expect(setup.context.client).toBe(injected);
  });

  it('creates an S3 offloader when s3 options are given', () => {
    const setup = setUpCheckpointer(
      { tableName: 'ckpt', client: fakeClientMethods(), s3: { bucketName: 'b' } },
      serde,
    );
    expect(setup.context.offloader).toBeDefined();
  });

  it('passes compression and ttl through to the context', () => {
    const setup = setUpCheckpointer(
      {
        tableName: 'ckpt',
        client: fakeClientMethods(),
        compression: { enabled: true },
        ttl: { days: 5 },
      },
      serde,
    );
    expect(setup.context.compression).toEqual({ enabled: true });
    expect(setup.context.ttl).toEqual({ days: 5 });
  });

  it('defaults the S3 key prefix to an adapter-scoped segment, but honors an explicit override', () => {
    const defaulted = setUpCheckpointer(
      { tableName: 'ckpt', client: fakeClientMethods(), s3: { bucketName: 'b' } },
      serde,
    );
    expect(defaulted.context.offloader?.getKeyPrefix()).toBe('langgraph-checkpoints/checkpointer/');

    const overridden = setUpCheckpointer(
      {
        tableName: 'ckpt',
        client: fakeClientMethods(),
        s3: { bucketName: 'b', keyPrefix: 'custom/' },
      },
      serde,
    );
    expect(overridden.context.offloader?.getKeyPrefix()).toBe('custom/');
  });
});

describe('collaborator shape (DDB-09)', () => {
  it('refuses an injected client missing a method this package calls', () => {
    expect(() =>
      setUpCheckpointer({ tableName: 'ckpt', client: { send: jest.fn() } as never }, serde),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION', context: { field: 'client.get' } }));
  });

  it('refuses a logger missing a level this package calls', () => {
    expect(() =>
      setUpCheckpointer(
        {
          tableName: 'ckpt',
          client: fakeClientMethods(),
          logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never,
        },
        serde,
      ),
    ).toThrow(expect.objectContaining({ code: 'VALIDATION', context: { field: 'logger.debug' } }));
  });

  it('refuses a serde missing a method this package calls', () => {
    expect(() =>
      setUpCheckpointer(
        {
          tableName: 'ckpt',
          client: fakeClientMethods(),
          serde: {
            dumpsTyped: () => Promise.resolve(['json', new Uint8Array()]),
          } as never,
        },
        serde,
      ),
    ).toThrow(
      expect.objectContaining({ code: 'VALIDATION', context: { field: 'serde.loadsTyped' } }),
    );
  });
});

describe('S3 region inheritance (CODEC-15)', () => {
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
    const setup = setUpCheckpointer(
      {
        tableName: 'ckpt',
        clientConfig: { region: 'eu-central-1' },
        createClient: () => ddb as never,
        s3: {
          bucketName: 'b',
          createS3Client: (config) => {
            seen = config;
            return s3Client as never;
          },
        },
      },
      serde,
    );
    await setup.context.offloader?.deleteBatch([]);
    expect(seen).toMatchObject({ region: 'eu-central-1' });
    setup.context.offloader?.destroy();
  });
});

describe('SDK retry stacking warning (DDB-01)', () => {
  it('warns at construction when an injected client keeps the SDK retries', async () => {
    const warn = jest.fn();
    const client = {
      ...fakeClientMethods(),
      send: jest.fn(),
      config: { maxAttempts: () => 3 },
    } as never;
    setUpCheckpointer(
      {
        tableName: 'ckpt',
        client,
        logger: { debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() },
      },
      serde,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does not warn for an owned client, which disables the SDK retries itself', async () => {
    const warn = jest.fn();
    const ddb = {
      destroy: jest.fn(),
      config: { maxAttempts: () => 1 },
      middlewareStack: fakeMiddlewareStack(),
      send: jest.fn(),
    };
    setUpCheckpointer(
      {
        tableName: 'ckpt',
        clientConfig: { region: 'eu-central-1' },
        createClient: () => ddb as never,
        logger: { debug: jest.fn(), info: jest.fn(), warn, error: jest.fn() },
      },
      serde,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('retry policy (DDB-03)', () => {
  it('resolves the retry policy onto the context, defaulting to five attempts', () => {
    const client = fakeClientMethods() as never;
    expect(setUpCheckpointer({ tableName: 't123', client }, serde).context.retry?.maxAttempts).toBe(
      5,
    );
    expect(
      setUpCheckpointer(
        { tableName: 't123', client, retry: { maxAttempts: 2, baseDelayMs: 1 } },
        serde,
      ).context.retry,
    ).toMatchObject({ maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5000 });
  });
});
