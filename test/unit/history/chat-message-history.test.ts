import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  BatchWriteCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { HumanMessage } from '@langchain/core/messages';
import { mockClient } from 'aws-sdk-client-mock';

import { DynamoDBChatMessageHistory } from '../../../src/history/chat-message-history';
import { DynamoDBSessionChatMessageHistory } from '../../../src/history/session-adapter';
import { JSON_SERDE } from '../../../src/shared/codec/json-serde';
import { createStrictDocumentMock } from '../../shared/helpers/ddb-mock';

const s3Mock = mockClient(S3Client);
afterEach(() => s3Mock.reset());

function history(client) {
  return new DynamoDBChatMessageHistory({ tableName: 'history', client, serde: JSON_SERDE });
}

describe('DynamoDBChatMessageHistory', () => {
  it('addMessage then getMessages round-trips through DynamoDB', async () => {
    const { client, mock } = createStrictDocumentMock();
    let written: unknown[] = [];
    mock.on(TransactWriteCommand).callsFake((input) => {
      written = input.TransactItems.slice(1).map((t: { Put: { Item: unknown } }) => t.Put.Item);
      return {};
    });
    mock.on(QueryCommand).callsFake(() => ({ Items: written }));
    const h = history(client);
    await h.addMessage('sess-1', new HumanMessage('hello'));
    const messages = await h.getMessages('sess-1');
    expect(messages.map((m) => m.content)).toEqual(['hello']);
  });

  it('clear deletes every item in the session partition', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({
      Items: [
        {
          PK: 'sess-1',
          SK: 'MSG#01A',
          message: { location: 'INLINE', serdeType: 'json', bytes: new Uint8Array() },
        },
        { PK: 'sess-1', SK: 'SESSION' },
      ],
    });
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    await history(client).clear('sess-1');
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(1);
  });

  it('listSessions scans for sessions', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({
      Items: [
        { PK: 's', SK: 'SESSION', sessionId: 's', messageCount: 1, createdAt: 'c', updatedAt: 'u' },
      ],
    });
    const sessions = await history(client).listSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(['s']);
  });

  it('reconcileMessageCount recomputes and writes back the stored count', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Count: 2 });
    mock.on(UpdateCommand).resolves({});
    await expect(history(client).reconcileMessageCount('sess-1')).resolves.toBe(2);
  });

  it('forSession returns a single-session adapter bound to the session', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const adapter = history(client).forSession('sess-9');
    expect(adapter).toBeInstanceOf(DynamoDBSessionChatMessageHistory);
    await adapter.addMessage(new HumanMessage('hi'));
    const item = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems[1].Put.Item;
    expect(item.PK).toBe('sess-9');
  });

  it('does not destroy an injected client but destroys an owned one', () => {
    const injected = createStrictDocumentMock();
    expect(() => history(injected.client).destroy()).not.toThrow();

    const destroy = jest.fn();
    const fake = { destroy, config: {}, middlewareStack: { clone: () => ({}) }, send: jest.fn() };
    const owned = new DynamoDBChatMessageHistory({
      tableName: 'history',
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
    const h = new DynamoDBChatMessageHistory({
      tableName: 'history',
      client,
      serde: JSON_SERDE,
      s3: { bucketName: 'b', createS3Client: () => new S3Client({ region: 'us-east-1' }) },
      ttl: { days: 30 },
    });
    await h.ensureS3LifecycleRule();
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
  });

  it('ensureS3LifecycleRule no-ops when ttl is not configured', async () => {
    const { client } = createStrictDocumentMock();
    const h = new DynamoDBChatMessageHistory({
      tableName: 'history',
      client,
      serde: JSON_SERDE,
      s3: { bucketName: 'b', createS3Client: () => new S3Client({ region: 'us-east-1' }) },
    });
    await expect(h.ensureS3LifecycleRule()).resolves.toBeUndefined();
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('ensureS3LifecycleRule no-ops when s3 is not configured', async () => {
    const { client } = createStrictDocumentMock();
    const h = new DynamoDBChatMessageHistory({
      tableName: 'history',
      client,
      serde: JSON_SERDE,
      ttl: { days: 30 },
    });
    await expect(h.ensureS3LifecycleRule()).resolves.toBeUndefined();
  });
});
