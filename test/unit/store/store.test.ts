import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

import { DynamoDBStore } from '../../../src/store/store';
import { createStrictDocumentMock } from '../../shared/helpers/ddb-mock';

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

  it('delete dispatches a DeleteCommand', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(DeleteCommand).resolves({});
    const store = new DynamoDBStore({ tableName: 'store', client });
    await store.delete(['n'], 'k');
    expect(mock.commandCalls(DeleteCommand)).toHaveLength(1);
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
    mock.on(ScanCommand).resolves({ Items: [{ namespace: ['a'] }] });
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
          embedDocuments: jest.fn(async (texts: string[]) => texts.map(() => [1])),
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
    const fake = { destroy, config: {}, middlewareStack: { clone: () => ({}) }, send: jest.fn() };
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
    const store = new DynamoDBStore({
      tableName: 'store',
      client,
      s3: { bucketName: 'b', createS3Client: () => new S3Client({ region: 'us-east-1' }) },
      ttl: { days: 30 },
    });
    await store.ensureS3LifecycleRule();
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
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
