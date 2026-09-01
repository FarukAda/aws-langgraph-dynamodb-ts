import { setUpCheckpointer } from '../../../../src/checkpointer/internal/setup';

const serde = {
  dumpsTyped: async (): Promise<[string, Uint8Array]> => ['json', new Uint8Array()],
  loadsTyped: async (): Promise<unknown> => ({}),
};

describe('setUpCheckpointer', () => {
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
    const fakeClient = { destroy: jest.fn(), config: {}, middlewareStack: {}, send: jest.fn() };
    const setup = setUpCheckpointer(
      {
        tableName: 'ckpt',
        clientConfig: { region: 'us-east-1' },
        createClient: () => fakeClient as never,
      },
      serde,
    );
    expect(setup.ownsClient).toBe(true);
    expect(setup.context.tableName).toBe('ckpt');
    expect(setup.context.serde).toBe(serde);
    expect(setup.context.offloader).toBeUndefined();
  });

  it('does not own an injected client', () => {
    const injected = { send: jest.fn() };
    const setup = setUpCheckpointer({ tableName: 'ckpt', client: injected as never }, serde);
    expect(setup.ownsClient).toBe(false);
    expect(setup.context.client).toBe(injected);
  });

  it('creates an S3 offloader when s3 options are given', () => {
    const setup = setUpCheckpointer(
      { tableName: 'ckpt', client: { send: jest.fn() } as never, s3: { bucketName: 'b' } },
      serde,
    );
    expect(setup.context.offloader).toBeDefined();
  });

  it('passes compression and ttl through to the context', () => {
    const setup = setUpCheckpointer(
      {
        tableName: 'ckpt',
        client: { send: jest.fn() } as never,
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
      { tableName: 'ckpt', client: { send: jest.fn() } as never, s3: { bucketName: 'b' } },
      serde,
    );
    expect(defaulted.context.offloader?.getKeyPrefix()).toBe('langgraph-checkpoints/checkpointer/');

    const overridden = setUpCheckpointer(
      {
        tableName: 'ckpt',
        client: { send: jest.fn() } as never,
        s3: { bucketName: 'b', keyPrefix: 'custom/' },
      },
      serde,
    );
    expect(overridden.context.offloader?.getKeyPrefix()).toBe('custom/');
  });
});
