import { randomUUID } from 'node:crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { AIMessage, HumanMessage } from '@langchain/core/messages';

import { sessionPartition } from '../../src/history/internal/keys';
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
      ExpressionAttributeValues: { ':pk': sessionPartition('s5'), ':msg': 'HISTORY#MSG#' },
    });
    const ttls = new Set((result.Items ?? []).map((item) => item.ttl));
    expect(result.Items).toHaveLength(8);
    expect(ttls.size).toBe(1);
    expect([...ttls][0]).toBeGreaterThan(0);
  });

  it('honours ClientRequestToken so a re-sent commit does not double-count', async () => {
    const doc = DynamoDBDocument.from(admin);
    const transaction = {
      TransactItems: [
        {
          Update: {
            TableName: tableName,
            Key: { PK: sessionPartition('s-idem'), SK: 'HISTORY#SESSION' },
            UpdateExpression: 'ADD #c :one',
            ExpressionAttributeNames: { '#c': 'messageCount' },
            ExpressionAttributeValues: { ':one': 1 },
          },
        },
        {
          Put: {
            TableName: tableName,
            Item: { PK: sessionPartition('s-idem'), SK: 'HISTORY#MSG#1' },
          },
        },
      ],
      ClientRequestToken: randomUUID(),
    };
    await doc.transactWrite(transaction);
    await doc.transactWrite(transaction);
    const meta = await doc.get({
      TableName: tableName,
      Key: { PK: sessionPartition('s-idem'), SK: 'HISTORY#SESSION' },
      ConsistentRead: true,
    });
    expect(meta.Item?.messageCount).toBe(1);
  });

  it('splits a >4MB un-offloaded batch into chunks with no loss or reordering', async () => {
    const big = 'x'.repeat(100_000);
    const messages = Array.from(
      { length: 60 },
      (_unused, index) => new HumanMessage(`${index}:${big}`),
    );
    await history.addMessages('s-big', messages);
    const stored = await history.getMessages('s-big');
    expect(stored).toHaveLength(60);
    expect(stored.map((m) => String(m.content).split(':')[0])).toEqual(
      messages.map((_unused, index) => String(index)),
    );
    const sessions = await history.listSessions();
    expect(sessions.find((s) => s.sessionId === 's-big')?.messageCount).toBe(60);
  });

  it('does not double-count when a committed transaction is retried after a lost response', async () => {
    const base = new DynamoDBClient(DDB_LOCAL_CONFIG);
    let injected = 0;
    base.middlewareStack.add(
      (next) => async (args) => {
        const input = args.input as { TransactItems?: unknown[] };
        if (Array.isArray(input.TransactItems) && injected === 0) {
          injected += 1;
          await next(args);
          throw Object.assign(new Error('simulated lost response'), { name: 'ServiceUnavailable' });
        }
        return next(args);
      },
      { step: 'initialize', name: 'lostResponseInjector', priority: 'high' },
    );
    const faulted = new DynamoDBChatMessageHistory({
      tableName,
      client: DynamoDBDocument.from(base),
    });
    await faulted.addMessages('s-fault', [new HumanMessage('only one')]);
    base.destroy();
    expect(injected).toBe(1);
    const messages = await history.getMessages('s-fault');
    expect(messages).toHaveLength(1);
    const sessions = await history.listSessions();
    expect(sessions.find((s) => s.sessionId === 's-fault')?.messageCount).toBe(1);
  });

  it('heals a stale (already-expired) ttl anchor instead of leaving new messages permanently invisible', async () => {
    const ttlHistory = new DynamoDBChatMessageHistory({
      tableName,
      clientConfig: DDB_LOCAL_CONFIG,
      ttl: { seconds: 3600 },
    });
    const sessionId = 's-heal';
    await ttlHistory.addMessages(sessionId, [new HumanMessage('first')]);

    // Force the persisted anchor into the past, simulating a session whose ttl
    // already lapsed but whose SESSION row survived (DynamoDB's TTL sweep can
    // lag up to 48h).
    const doc = DynamoDBDocument.from(admin);
    const pastTtl = Math.floor(Date.now() / 1000) - 100;
    await doc.update({
      TableName: tableName,
      Key: { PK: sessionPartition(sessionId), SK: 'HISTORY#SESSION' },
      UpdateExpression: 'SET #ttl = :past',
      ExpressionAttributeNames: { '#ttl': 'ttl' },
      ExpressionAttributeValues: { ':past': pastTtl },
    });

    await ttlHistory.addMessages(sessionId, [new HumanMessage('second')]);
    ttlHistory.destroy();

    // Pre-fix, 'second' would have been stamped with the already-expired
    // anchor and silently filtered out on read.
    const messages = await history.getMessages(sessionId);
    expect(messages.map((m) => m.content)).toEqual(['first', 'second']);

    const meta = await doc.get({
      TableName: tableName,
      Key: { PK: sessionPartition(sessionId), SK: 'HISTORY#SESSION' },
      ConsistentRead: true,
    });
    expect(meta.Item?.ttl).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('reconcileMessageCount throws ConflictError instead of creating a junk row for a nonexistent session', async () => {
    const sessionId = 'ghost-session';
    await expect(history.reconcileMessageCount(sessionId)).rejects.toMatchObject({
      name: 'ConflictError',
    });

    const doc = DynamoDBDocument.from(admin);
    const raw = await doc.get({
      TableName: tableName,
      Key: { PK: sessionPartition(sessionId), SK: 'HISTORY#SESSION' },
      ConsistentRead: true,
    });
    expect(raw.Item).toBeUndefined();
  });
});
