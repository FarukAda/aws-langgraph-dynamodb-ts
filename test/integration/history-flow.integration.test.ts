import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { AIMessage, HumanMessage } from '@langchain/core/messages';

import { DynamoDBChatMessageHistory } from '../../src/index';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from './helpers/ddb-local';

const tableName = 'history-itest';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
let history: DynamoDBChatMessageHistory;

beforeAll(async () => {
  await createTable(admin, tableName);
  history = new DynamoDBChatMessageHistory({ tableName, clientConfig: DDB_LOCAL_CONFIG });
});

afterAll(async () => {
  history.destroy();
  await deleteTable(admin, tableName);
  admin.destroy();
});

describe('DynamoDBChatMessageHistory end-to-end against real DynamoDB', () => {
  it('appends messages across calls and reads them back in order', async () => {
    await history.addMessages('s1', [new HumanMessage('one'), new AIMessage('two')]);
    await history.addMessages('s1', [new HumanMessage('three')]);
    const messages = await history.getMessages('s1');
    expect(messages.map((m) => m.content)).toEqual(['one', 'two', 'three']);
  });

  it('lists sessions with derived metadata', async () => {
    await history.addMessages('s2', [new HumanMessage('hello world')]);
    const sessions = await history.listSessions();
    const s2 = sessions.find((s) => s.sessionId === 's2');
    expect(s2?.title).toBe('hello world');
    expect(s2?.messageCount).toBe(1);
  });

  it('clears a whole session', async () => {
    await history.addMessages('s3', [new HumanMessage('x'), new AIMessage('y')]);
    await history.clear('s3');
    expect(await history.getMessages('s3')).toEqual([]);
  });

  it('keeps every message under concurrent appends (lock-free)', async () => {
    await Promise.all(
      Array.from({ length: 10 }, (_unused, index) =>
        history.addMessages('s4', [new HumanMessage(`m${index}`)]),
      ),
    );
    const messages = await history.getMessages('s4');
    expect(messages).toHaveLength(10);
    expect(new Set(messages.map((m) => m.content)).size).toBe(10);
    const sessions = await history.listSessions();
    expect(sessions.find((s) => s.sessionId === 's4')?.messageCount).toBe(10);
  });

  it('stamps one uniform creation-anchored ttl across concurrent first appends', async () => {
    const ttlHistory = new DynamoDBChatMessageHistory({
      tableName,
      clientConfig: DDB_LOCAL_CONFIG,
      ttl: { seconds: 3600 },
    });
    await Promise.all(
      Array.from({ length: 8 }, (_unused, index) =>
        ttlHistory.addMessages('s5', [new HumanMessage(`c${index}`)]),
      ),
    );
    ttlHistory.destroy();
    const doc = DynamoDBDocument.from(admin);
    const result = await doc.query({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :msg)',
      ExpressionAttributeValues: { ':pk': 's5', ':msg': 'MSG#' },
    });
    const ttls = new Set((result.Items ?? []).map((item) => item.ttl));
    expect(result.Items).toHaveLength(8);
    expect(ttls.size).toBe(1);
    expect([...ttls][0]).toBeGreaterThan(0);
  });
});
