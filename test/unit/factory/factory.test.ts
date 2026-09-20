import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

import { DynamoDBSaver } from '../../../src/checkpointer/saver';
import { DynamoDBFactory } from '../../../src/factory/factory';
import { DynamoDBChatMessageHistory } from '../../../src/history/chat-message-history';
import { ErrorCode } from '../../../src/shared/errors/error-code';
import { DynamoDBStore } from '../../../src/store/store';
import { createStrictDocumentMock, fakeMiddlewareStack } from '../../shared/helpers/ddb-mock';

const s3Mock = mockClient(S3Client);
afterEach(() => s3Mock.reset());

/**
 * An unstubbed `GetBucketVersioning` resolves as nothing through
 * `aws-sdk-client-mock`, which this package reads as a failed versioning check
 * and warns about. Every provisioning case therefore asserts on a logger: a
 * dropped stub would otherwise leave the case green while it proved the
 * opposite of its name.
 */
function fakeLogger() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function fakeClientFactory() {
  const destroy = jest.fn();
  const client = { destroy, config: {}, middlewareStack: fakeMiddlewareStack(), send: jest.fn() };
  return { destroy, create: () => client as never };
}

describe('DynamoDBFactory', () => {
  it('builds each adapter individually', () => {
    const factory = new DynamoDBFactory({ clientConfig: { region: 'eu-west-1' } });
    const { client } = createStrictDocumentMock();
    expect(factory.createSaver({ tableName: 'ckpt', client })).toBeInstanceOf(DynamoDBSaver);
    expect(factory.createStore({ tableName: 'store', client })).toBeInstanceOf(DynamoDBStore);
    expect(factory.createChatMessageHistory({ tableName: 'hist', client })).toBeInstanceOf(
      DynamoDBChatMessageHistory,
    );
  });

  it('individual create* calls fall back to the factory client defaults', () => {
    const fake = fakeClientFactory();
    const factory = new DynamoDBFactory({
      clientConfig: { region: 'eu-west-1' },
      createClient: fake.create,
    });
    const saver = factory.createSaver({ tableName: 'ckpt' });
    saver.destroy();
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });

  it('createAll shares one client and destroys it exactly once', () => {
    const fake = fakeClientFactory();
    const factory = new DynamoDBFactory({
      clientConfig: { region: 'eu-west-1' },
      createClient: fake.create,
    });
    const all = factory.createAll({
      saver: { tableName: 'checkpoints' },
      store: { tableName: 'store' },
      history: { tableName: 'history' },
    });
    expect(all.saver).toBeInstanceOf(DynamoDBSaver);
    expect(all.store).toBeInstanceOf(DynamoDBStore);
    expect(all.history).toBeInstanceOf(DynamoDBChatMessageHistory);
    all.destroy();
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });

  it('createAll reuses an injected base client instead of building a new one', () => {
    const { client } = createStrictDocumentMock();
    const destroySpy = jest.spyOn(client, 'destroy');
    const factory = new DynamoDBFactory({ client });
    const all = factory.createAll({
      saver: { tableName: 'ckpt' },
      store: { tableName: 'store' },
      history: { tableName: 'hist' },
    });
    expect(all.saver).toBeInstanceOf(DynamoDBSaver);
    all.destroy();
    // The factory doesn't own an injected client, so tearing every adapter
    // down must never destroy the caller's own client out from under them.
    expect(destroySpy).not.toHaveBeenCalled();
  });

  it('createAll builds a default client when no factory base options are given', () => {
    const factory = new DynamoDBFactory();
    const all = factory.createAll({
      saver: { tableName: 'ckpt' },
      store: { tableName: 'store' },
      history: { tableName: 'hist' },
    });
    expect(all.saver).toBeInstanceOf(DynamoDBSaver);
    expect(() => all.destroy()).not.toThrow();
  });

  /** Partial on purpose: the whole built config is pinned by the client's own test. */
  it('createAll passes maxAttempts: 1 through to the client factory (disables SDK-internal retries)', () => {
    const fake = fakeClientFactory();
    const createClient = jest.fn(fake.create);
    const factory = new DynamoDBFactory({ clientConfig: { region: 'eu-west-1' }, createClient });
    factory.createAll({
      saver: { tableName: 'ckpt' },
      store: { tableName: 'store' },
      history: { tableName: 'hist' },
    });
    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({ maxAttempts: 1, region: 'eu-west-1' }),
    );
  });
});

describe('the factory validates its own defaults', () => {
  /**
   * The same base was refused by the first `create*` call and accepted by
   * `createAll`, so whether the mistake was reported depended on which method
   * the caller reached for.
   */
  it('refuses a client alongside a clientConfig, where the caller wrote it', () => {
    const { client } = createStrictDocumentMock();
    expect(() => new DynamoDBFactory({ client, clientConfig: { region: 'eu-west-1' } })).toThrow(
      /either `client` or `clientConfig`/,
    );
  });

  it('refuses an option it does not read', () => {
    expect(() => new DynamoDBFactory({ s3Config: { bucketName: 'b' } } as never)).toThrow(
      /options.s3Config/,
    );
  });

  it('accepts no options at all', () => {
    expect(() => new DynamoDBFactory()).not.toThrow();
  });
});

describe('createAll rejects a section it cannot build', () => {
  /**
   * `CreateAllOptions` has three keys, and a misspelt one escapes the type
   * through any variable that is not an object literal: the call then built
   * nothing and handed back three `undefined`s.
   */
  it('refuses a key that is not a section name', () => {
    const factory = new DynamoDBFactory({ client: createStrictDocumentMock().client });
    expect(() => factory.createAll({ savers: { tableName: 'ckpt' } } as never)).toThrow(
      /options.savers/,
    );
  });

  it('builds nothing for an empty selection', () => {
    const fake = fakeClientFactory();
    const factory = new DynamoDBFactory({ createClient: fake.create });
    const all = factory.createAll({});
    expect([all.saver, all.store, all.history]).toEqual([undefined, undefined, undefined]);
    all.destroy();
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });
});

describe('createAll teardown is total', () => {
  const throwingS3 = () => ({
    bucketName: 'shared',
    createS3Client: () => {
      const client = new S3Client({ region: 'us-east-1' });
      client.destroy = (): never => {
        throw new Error('socket already closed');
      };
      return client;
    },
  });

  /**
   * A teardown failure used to strand every resource after it — including the
   * shared client, which no other code can reach once `destroy` has returned.
   */
  it('releases the rest when one adapter fails to release its own', async () => {
    const fake = fakeClientFactory();
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [] });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    const logger = fakeLogger();
    const factory = new DynamoDBFactory({
      createClient: fake.create,
      logger,
      ttl: { days: 30 },
      s3: throwingS3(),
    });
    const all = factory.createAll({ saver: { tableName: 'ckpt' }, store: { tableName: 'store' } });
    await all.saver.ensureS3LifecycleRule();
    await all.store.ensureS3LifecycleRule();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(() => all.destroy()).not.toThrow();
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });

  /**
   * The rollback of a failed build runs the same teardown, where a throw would
   * replace the constructor error the caller actually needs.
   */
  it('reports the constructor error, not a teardown failure', () => {
    const client = {
      destroy: () => {
        throw new Error('socket already closed');
      },
      config: {},
      middlewareStack: fakeMiddlewareStack(),
      send: jest.fn(),
    };
    const factory = new DynamoDBFactory({ createClient: () => client as never });
    expect(() =>
      factory.createAll({
        store: { tableName: 'store', vectorBackend: {} as never },
      }),
    ).toThrow(/vectorBackend requires a configured/);
  });
});

describe('shared adapter defaults (CORE-17)', () => {
  const s3 = () => ({
    bucketName: 'shared',
    createS3Client: () => new S3Client({ region: 'us-east-1' }),
  });

  function lifecycleDays(): number[] {
    return s3Mock
      .commandCalls(PutBucketLifecycleConfigurationCommand)
      .map((call) => JSON.stringify(call.args[0].input))
      .map((json) => Number(/"Days":(\d+)/.exec(json)![1]));
  }

  /**
   * An adapter reads the S3 region off its own `clientConfig`, and the adapters
   * `createAll` builds are handed the shared `client` instead — so the region
   * has to travel on the `s3` config. Without it a bucket reachable only
   * through that region failed with `PermanentRedirect` on the first offload,
   * while the same configuration through `createStore` worked.
   */
  it('gives every adapter the DynamoDB region for S3, on both build paths', async () => {
    const seen: object[] = [];
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [] });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    const logger = fakeLogger();
    const base = {
      clientConfig: { region: 'eu-central-1' },
      createClient: fakeClientFactory().create,
      logger,
      ttl: { days: 30 },
      s3: {
        bucketName: 'shared',
        createS3Client: (config: object) => {
          seen.push(config);
          return new S3Client({ region: 'us-east-1' });
        },
      },
    };

    const store = new DynamoDBFactory(base).createStore({ tableName: 'store' });
    await store.ensureS3LifecycleRule();
    expect(seen.pop()).toMatchObject({ region: 'eu-central-1' });

    const all = new DynamoDBFactory(base).createAll({ store: { tableName: 'store' } });
    await all.store.ensureS3LifecycleRule();
    expect(seen.pop()).toMatchObject({ region: 'eu-central-1' });
    expect(logger.warn).not.toHaveBeenCalled();
    all.destroy();
  });

  it('propagates shared ttl and s3 to every adapter, a per-adapter ttl winning', async () => {
    const { client } = createStrictDocumentMock();
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [] });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    const logger = fakeLogger();
    const factory = new DynamoDBFactory({ client, logger, ttl: { days: 30 }, s3: s3() });
    const all = factory.createAll({
      saver: { tableName: 'ckpt' },
      store: { tableName: 'store', ttl: { days: 1 } },
      history: { tableName: 'hist' },
    });
    await all.saver.ensureS3LifecycleRule();
    await all.store.ensureS3LifecycleRule();
    await all.history.ensureS3LifecycleRule();
    expect(lifecycleDays()).toEqual([32, 3, 32]);
    expect(logger.warn).not.toHaveBeenCalled();
    all.destroy();
  });

  it('keeps the shared ttl and s3 when a per-adapter client displaces the base client', async () => {
    const fake = fakeClientFactory();
    const create = jest.fn(fake.create);
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [] });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    const logger = fakeLogger();
    const factory = new DynamoDBFactory({
      clientConfig: { region: 'eu-west-1' },
      createClient: create,
      logger,
      ttl: { days: 30 },
      s3: s3(),
    });
    const saver = factory.createSaver({
      tableName: 'ckpt',
      client: createStrictDocumentMock().client,
    });
    await saver.ensureS3LifecycleRule();
    expect(lifecycleDays()).toEqual([32]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('propagates shared compression to the store', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    let written: Record<string, { compressed?: boolean }> | undefined;
    mock.on(PutCommand).callsFake((input) => {
      written = input.Item;
      return {};
    });
    const factory = new DynamoDBFactory({
      client,
      compression: { enabled: true, minSizeBytes: 0 },
    });
    const all = factory.createAll({ store: { tableName: 'store' } });
    await all.store.put(['n'], 'k', { text: 'x'.repeat(64) });
    expect(written?.value.compressed).toBe(true);
  });

  it('propagates the shared retry policy, a per-adapter policy winning', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).rejects(Object.assign(new Error('slow'), { name: 'ThrottlingException' }));
    const factory = new DynamoDBFactory({
      client,
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 1 },
    });
    const shared = factory.createAll({ store: { tableName: 'store' } }).store;
    await expect(shared.get(['n'], 'k')).rejects.toMatchObject({ code: ErrorCode.RETRY_EXHAUSTED });
    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
    const own = factory.createStore({
      tableName: 'store',
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    });
    await expect(own.get(['n'], 'k')).rejects.toMatchObject({ code: ErrorCode.RETRY_EXHAUSTED });
    expect(mock.commandCalls(GetCommand)).toHaveLength(3);
  });
});

describe('partial createAll and cleanup on failure (CORE-17)', () => {
  it('builds only the requested adapters', () => {
    const { client } = createStrictDocumentMock();
    const factory = new DynamoDBFactory({ client });
    const storeOnly = factory.createAll({ store: { tableName: 'store' } });
    expect(storeOnly.store).toBeInstanceOf(DynamoDBStore);
    expect(storeOnly.saver).toBeUndefined();
    expect(storeOnly.history).toBeUndefined();
    expect(() => storeOnly.destroy()).not.toThrow();
    const saverOnly = factory.createAll({ saver: { tableName: 'ckpt' } });
    expect(saverOnly.saver).toBeInstanceOf(DynamoDBSaver);
    expect(saverOnly.store).toBeUndefined();
  });

  it('destroys the freshly built client when an adapter constructor throws', () => {
    const fake = fakeClientFactory();
    const factory = new DynamoDBFactory({
      clientConfig: { region: 'eu-west-1' },
      createClient: fake.create,
    });
    expect(() =>
      factory.createAll({
        saver: { tableName: 'ckpt' },
        store: {
          tableName: 'store',
          vectorBackend: { upsert: jest.fn(), delete: jest.fn(), query: jest.fn() },
        },
      }),
    ).toThrow(expect.objectContaining({ code: ErrorCode.VALIDATION }));
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });
});
