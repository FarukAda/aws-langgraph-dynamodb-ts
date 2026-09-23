import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

import { ErrorCode } from '../../../src/shared/errors/error-code';
import { DynamoDBStore } from '../../../src/store/store';
import {
  answerDeleteReads,
  createStrictDocumentMock,
  deletedKeys,
  fakeMiddlewareStack,
  observableRow,
  resolveRowDeletes,
} from '../../shared/helpers/ddb-mock';

const s3Mock = mockClient(S3Client);
afterEach(() => s3Mock.reset());

describe('DynamoDBStore', () => {
  it('put then get round-trips an item (dispatch: put + get)', async () => {
    const { client, mock } = createStrictDocumentMock();
    let stored: Record<string, unknown> | undefined;
    mock.on(GetCommand).callsFake((input) => (input.ProjectionExpression ? {} : { Item: stored }));
    mock.on(PutCommand).callsFake((input) => {
      stored = input.Item;
      return {};
    });
    const store = new DynamoDBStore({ tableName: 'store', client });
    await store.put(['users', 'u1'], 'profile', { name: 'Faruk' });
    const item = await store.get(['users', 'u1'], 'profile');
    expect(item?.value).toEqual({ name: 'Faruk' });
  });

  it('delete reads the row and removes the one it read', async () => {
    const { client, mock } = createStrictDocumentMock();
    answerDeleteReads(mock, observableRow());
    resolveRowDeletes(mock);
    const store = new DynamoDBStore({ tableName: 'store', client });
    await store.delete(['n'], 'k');
    expect(deletedKeys(mock)).toHaveLength(1);
  });

  it('search dispatches a scoped Query and returns matches', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    const store = new DynamoDBStore({ tableName: 'store', client });
    expect(await store.search(['users'])).toEqual([]);
    expect(mock.commandCalls(QueryCommand)).toHaveLength(1);
  });

  it('listNamespaces dispatches a Scan', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(ScanCommand)
      .resolves({ Items: [{ PK: 'STORE#a', SK: 'k', namespace: ['a'], key: 'k' }] });
    const store = new DynamoDBStore({ tableName: 'store', client });
    expect(await store.listNamespaces()).toEqual([['a']]);
  });

  it('executes a mixed batch in order', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(QueryCommand).resolves({ Items: [] });
    const store = new DynamoDBStore({ tableName: 'store', client });
    const results = await store.batch([{ namespace: ['n'], key: 'k' }, { namespacePrefix: ['n'] }]);
    expect(results).toEqual([null, []]);
  });

  it('delegates reconcileVectorIndex to the action', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    const backend = {
      upsert: jest.fn(),
      delete: jest.fn(),
      query: jest.fn(),
      listKeys: jest.fn().mockResolvedValue([]),
    };
    const store = new DynamoDBStore({
      tableName: 'store',
      client,
      index: {
        dims: 1,
        embeddings: {
          embedQuery: jest.fn(),
          embedDocuments: jest.fn((texts: string[]) => texts.map(() => [1])),
        } as never,
      },
      vectorBackend: backend,
    });
    const result = await store.reconcileVectorIndex(['users', 'u1']);
    expect(result).toEqual({ upserted: 0, pruned: 0 });
    expect(backend.listKeys).toHaveBeenCalledWith(['users', 'u1']);
  });

  it('does not destroy an injected client but does destroy an owned one', () => {
    const injected = createStrictDocumentMock();
    expect(() =>
      new DynamoDBStore({ tableName: 'store', client: injected.client }).destroy(),
    ).not.toThrow();

    const destroy = jest.fn();
    const fake = { destroy, config: {}, middlewareStack: fakeMiddlewareStack(), send: jest.fn() };
    const owned = new DynamoDBStore({
      tableName: 'store',
      clientConfig: { region: 'us-east-1' },
      createClient: () => fake as never,
    });
    owned.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('ensureS3LifecycleRule provisions the rule when both s3 and ttl are configured', async () => {
    const { client } = createStrictDocumentMock();
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [] });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const store = new DynamoDBStore({
      tableName: 'store',
      client,
      logger,
      s3: { bucketName: 'b', createS3Client: () => new S3Client({ region: 'us-east-1' }) },
      ttl: { days: 30 },
    });
    /** The injected client has maxAttempts > 1, triggering a warning asynchronously during setup. */
    await new Promise((resolve) => setImmediate(resolve));
    logger.warn.mockClear();
    await store.ensureS3LifecycleRule();
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
    /** A warn here would mean the versioning stub above was not the one consumed. */
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('ensureS3LifecycleRule no-ops when ttl is not configured', async () => {
    const { client } = createStrictDocumentMock();
    const store = new DynamoDBStore({
      tableName: 'store',
      client,
      s3: { bucketName: 'b', createS3Client: () => new S3Client({ region: 'us-east-1' }) },
    });
    await expect(store.ensureS3LifecycleRule()).resolves.toBeUndefined();
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('ensureS3LifecycleRule no-ops when s3 is not configured', async () => {
    const { client } = createStrictDocumentMock();
    const store = new DynamoDBStore({ tableName: 'store', client, ttl: { days: 30 } });
    await expect(store.ensureS3LifecycleRule()).resolves.toBeUndefined();
  });
});

describe('cancellation via { signal } (CORE-04)', () => {
  it('rejects search and reconcileVectorIndex before any DynamoDB call', async () => {
    const { client, mock } = createStrictDocumentMock();
    const controller = new AbortController();
    controller.abort();
    const embeddings = { embedQuery: jest.fn(), embedDocuments: jest.fn() };
    const backend = { upsert: jest.fn(), delete: jest.fn(), query: jest.fn() };
    const store = new DynamoDBStore({
      tableName: 'store',
      client,
      index: { dims: 1, embeddings: embeddings as never },
      vectorBackend: backend,
    });
    await expect(store.search(['ns'], { signal: controller.signal })).rejects.toMatchObject({
      code: ErrorCode.ABORTED,
      name: 'DynamoDBLangGraphError',
    });
    await expect(
      store.reconcileVectorIndex(['ns'], { signal: controller.signal }),
    ).rejects.toMatchObject({ code: ErrorCode.ABORTED });
    expect(mock.calls()).toHaveLength(0);
  });
});

describe('BaseStore lifecycle (CORE-22)', () => {
  it('stop() releases an owned client exactly once and leaves an injected one alone', () => {
    const destroy = jest.fn();
    const fake = { destroy, config: {}, middlewareStack: fakeMiddlewareStack(), send: jest.fn() };
    const owned = new DynamoDBStore({
      tableName: 'store',
      clientConfig: { region: 'us-east-1' },
      createClient: () => fake as never,
    });
    owned.stop();
    expect(destroy).toHaveBeenCalledTimes(1);
    const injected = createStrictDocumentMock();
    const spy = jest.spyOn(injected.client, 'destroy');
    new DynamoDBStore({ tableName: 'store', client: injected.client }).stop();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('options shape (M-08)', () => {
  /**
   * The `= {}` default parameter only fires for `undefined`, not `null`, so a
   * caller passing `null` used to reach the destructure before `guardPublic`
   * could normalise the resulting `TypeError`. The destructure now runs
   * inside the guarded callback, after `assertShape` has already refused a
   * non-object `options`.
   */
  it('search names the field rather than crashing when options is null', async () => {
    const { client } = createStrictDocumentMock();
    const store = new DynamoDBStore({ tableName: 'store', client });
    await expect(store.search(['ns'], null as never)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'options' },
    });
  });

  it('search refuses a key this package does not read', async () => {
    const { client } = createStrictDocumentMock();
    const store = new DynamoDBStore({ tableName: 'store', client });
    await expect(store.search(['ns'], { bogus: true } as never)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'options.bogus' },
    });
  });

  it('search refuses a signal that is not AbortSignal-like', async () => {
    const { client } = createStrictDocumentMock();
    const store = new DynamoDBStore({ tableName: 'store', client });
    await expect(store.search(['ns'], { signal: {} as never })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'signal' },
    });
  });

  it('search refuses a non-object filter, naming it', async () => {
    const { client } = createStrictDocumentMock();
    const store = new DynamoDBStore({ tableName: 'store', client });
    await expect(store.search(['ns'], { filter: 'x' as never })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'filter' },
    });
  });

  it('search refuses a non-string query, naming it', async () => {
    const { client } = createStrictDocumentMock();
    const store = new DynamoDBStore({ tableName: 'store', client });
    await expect(store.search(['ns'], { query: 123 as never })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'query' },
    });
  });

  it('search accepts an empty query and a non-operator filter clause', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    const store = new DynamoDBStore({ tableName: 'store', client });
    await expect(store.search(['ns'], { query: '' })).resolves.toEqual([]);
    await expect(store.search(['ns'], { filter: { a: { $foo: 1 } } })).resolves.toEqual([]);
  });

  it('reconcileVectorIndex refuses a key this package does not read', async () => {
    const { client } = createStrictDocumentMock();
    const store = new DynamoDBStore({ tableName: 'store', client });
    await expect(
      store.reconcileVectorIndex(['ns'], { bogus: true } as never),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'options.bogus' } });
  });
});

describe('collaborator shape (DDB-09)', () => {
  it('refuses a raw DynamoDBClient where a DynamoDBDocument is required', () => {
    const raw = { send: () => undefined };
    expect(() => new DynamoDBStore({ tableName: 'tbl', client: raw as never })).toThrow(
      expect.objectContaining({ code: 'VALIDATION', context: { field: 'client.get' } }),
    );
  });
});
