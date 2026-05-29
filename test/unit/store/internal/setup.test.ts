import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
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
  });

  it('does not own an injected client and carries index/compression/ttl', () => {
    const index = { dims: 3, embeddings: {} as never };
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
});
