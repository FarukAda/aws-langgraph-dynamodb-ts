import { randomUUID } from 'node:crypto';

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { Checkpoint } from '@langchain/langgraph-checkpoint';

import { DynamoDBChatMessageHistory, DynamoDBSaver } from '../../src/index';

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
const clientConfig = region ? { region } : {};
const tableName = `aws-langgraph-awstest-${randomUUID()}`;

function checkpoint(id: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date(0).toISOString(),
    channel_values: { messages: ['x'] },
    channel_versions: { messages: 1 },
    versions_seen: {},
  };
}

/**
 * Real-AWS verification. Not part of `npm test` or `npm run test:integration`;
 * run explicitly with `npm run test:aws` against an account whose credentials
 * are on the default chain. Creates one on-demand table and deletes it after.
 */
describe('DynamoDB adapters against real AWS', () => {
  let admin: DynamoDBClient;
  let history: DynamoDBChatMessageHistory;
  let saver: DynamoDBSaver;

  beforeAll(async () => {
    admin = new DynamoDBClient(clientConfig);
    await admin.send(
      new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: [
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        BillingMode: 'PAY_PER_REQUEST',
      }),
    );
    await waitUntilTableExists({ client: admin, maxWaitTime: 90 }, { TableName: tableName });
    await admin.send(
      new UpdateTimeToLiveCommand({
        TableName: tableName,
        TimeToLiveSpecification: { Enabled: true, AttributeName: 'ttl' },
      }),
    );
    history = new DynamoDBChatMessageHistory({ tableName, clientConfig });
    saver = new DynamoDBSaver({ tableName, clientConfig });
  });

  afterAll(async () => {
    history?.destroy();
    saver?.destroy();
    if (admin) {
      await admin.send(new DeleteTableCommand({ TableName: tableName }));
      await waitUntilTableNotExists({ client: admin, maxWaitTime: 90 }, { TableName: tableName });
      admin.destroy();
    }
  });

  it('appends across calls preserving order', async () => {
    await history.addMessages('s1', [new HumanMessage('one'), new AIMessage('two')]);
    await history.addMessages('s1', [new HumanMessage('three')]);
    const messages = await history.getMessages('s1');
    expect(messages.map((m) => m.content)).toEqual(['one', 'two', 'three']);
  });

  it('replays 12 pending writes in numeric index order', async () => {
    await saver.put(
      { configurable: { thread_id: 't1', checkpoint_ns: '' } },
      checkpoint('c1'),
      { source: 'loop', step: 1, parents: {} },
      {},
    );
    const writes = Array.from(
      { length: 12 },
      (_unused, i) => [`ch${i}`, `v${i}`] as [string, string],
    );
    await saver.putWrites(
      { configurable: { thread_id: 't1', checkpoint_ns: '', checkpoint_id: 'c1' } },
      writes,
      'task-1',
    );
    const tuple = await saver.getTuple({ configurable: { thread_id: 't1', checkpoint_id: 'c1' } });
    expect(tuple?.pendingWrites).toEqual(writes.map(([c, v]) => ['task-1', c, v]));
  });

  it('keeps every message and an exact count under 30 concurrent appends', async () => {
    await Promise.all(
      Array.from({ length: 30 }, (_unused, i) =>
        history.addMessages('hot', [new HumanMessage(`m${i}`)]),
      ),
    );
    const messages = await history.getMessages('hot');
    expect(messages).toHaveLength(30);
    expect(new Set(messages.map((m) => m.content)).size).toBe(30);
    const sessions = await history.listSessions();
    expect(sessions.find((s) => s.sessionId === 'hot')?.messageCount).toBe(30);
  });

  it('applies a re-sent ClientRequestToken exactly once', async () => {
    const doc = DynamoDBDocument.from(admin);
    const transaction = {
      TransactItems: [
        {
          Update: {
            TableName: tableName,
            Key: { PK: 'idem', SK: 'SESSION' },
            UpdateExpression: 'ADD #c :one',
            ExpressionAttributeNames: { '#c': 'messageCount' },
            ExpressionAttributeValues: { ':one': 1 },
          },
        },
        { Put: { TableName: tableName, Item: { PK: 'idem', SK: 'MSG#1' } } },
      ],
      ClientRequestToken: randomUUID(),
    };
    await doc.transactWrite(transaction);
    await doc.transactWrite(transaction);
    const meta = await doc.get({
      TableName: tableName,
      Key: { PK: 'idem', SK: 'SESSION' },
      ConsistentRead: true,
    });
    expect(meta.Item?.messageCount).toBe(1);
  });

  it('chunks a >4MB un-offloaded batch with no loss or reorder', async () => {
    const big = 'x'.repeat(100000);
    const messages = Array.from({ length: 60 }, (_unused, i) => new HumanMessage(`${i}:${big}`));
    await history.addMessages('big', messages);
    const stored = await history.getMessages('big');
    expect(stored).toHaveLength(60);
    expect(stored.map((m) => String(m.content).split(':')[0])).toEqual(
      messages.map((_unused, i) => String(i)),
    );
  });

  it('stamps one uniform ttl across messages when ttl is configured', async () => {
    const ttlHistory = new DynamoDBChatMessageHistory({
      tableName,
      clientConfig,
      ttl: { seconds: 3600 },
    });
    await ttlHistory.addMessages('ttlsess', [new HumanMessage('a'), new HumanMessage('b')]);
    ttlHistory.destroy();
    const doc = DynamoDBDocument.from(admin);
    const result = await doc.query({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :m)',
      ExpressionAttributeValues: { ':pk': 'ttlsess', ':m': 'MSG#' },
    });
    const ttls = new Set((result.Items ?? []).map((it) => it.ttl));
    expect(result.Items).toHaveLength(2);
    expect(ttls.size).toBe(1);
  });
});
