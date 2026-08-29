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
import { ERROR, type Checkpoint } from '@langchain/langgraph-checkpoint';

import { partitionKey, payloadSortKey } from '../../src/checkpointer/internal/keys';
import { sessionPartition } from '../../src/history/internal/keys';
import { DynamoDBChatMessageHistory, DynamoDBSaver, DynamoDBStore } from '../../src/index';

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
  let store: DynamoDBStore;

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
    store = new DynamoDBStore({ tableName, clientConfig });
  });

  afterAll(async () => {
    history?.destroy();
    saver?.destroy();
    store?.destroy();
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
    await saver.put({ configurable: { thread_id: 't1', checkpoint_ns: '' } }, checkpoint('c1'), {
      source: 'loop',
      step: 1,
      parents: {},
    });
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
            Key: { PK: 'idem', SK: 'HISTORY#SESSION' },
            UpdateExpression: 'ADD #c :one',
            ExpressionAttributeNames: { '#c': 'messageCount' },
            ExpressionAttributeValues: { ':one': 1 },
          },
        },
        { Put: { TableName: tableName, Item: { PK: 'idem', SK: 'HISTORY#MSG#1' } } },
      ],
      ClientRequestToken: randomUUID(),
    };
    await doc.transactWrite(transaction);
    await doc.transactWrite(transaction);
    const meta = await doc.get({
      TableName: tableName,
      Key: { PK: 'idem', SK: 'HISTORY#SESSION' },
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
      ExpressionAttributeValues: { ':pk': sessionPartition('ttlsess'), ':m': 'HISTORY#MSG#' },
    });
    const ttls = new Set((result.Items ?? []).map((it) => it.ttl));
    expect(result.Items).toHaveLength(2);
    expect(ttls.size).toBe(1);
  });

  it('lists checkpoints newest-first, honoring limit and before', async () => {
    const threadId = 'list-thread';
    const config = { configurable: { thread_id: threadId, checkpoint_ns: '' } };
    await saver.put(config, checkpoint('lc1'), { source: 'loop', step: 1, parents: {} });
    await saver.put(config, checkpoint('lc2'), { source: 'loop', step: 2, parents: {} });
    await saver.put(config, checkpoint('lc3'), { source: 'loop', step: 3, parents: {} });

    const all: string[] = [];
    for await (const tuple of saver.list(config)) all.push(tuple.checkpoint.id);
    expect(all).toEqual(['lc3', 'lc2', 'lc1']);

    const limited: string[] = [];
    for await (const tuple of saver.list(config, { limit: 2 })) limited.push(tuple.checkpoint.id);
    expect(limited).toEqual(['lc3', 'lc2']);

    const before: string[] = [];
    for await (const tuple of saver.list(config, {
      before: { configurable: { checkpoint_id: 'lc3' } },
    })) {
      before.push(tuple.checkpoint.id);
    }
    expect(before).toEqual(['lc2', 'lc1']);
  });

  it('deleteThread removes every checkpoint, payload, and write for the thread', async () => {
    const threadId = 'delete-thread';
    const config = { configurable: { thread_id: threadId, checkpoint_ns: '' } };
    await saver.put(config, checkpoint('dc1'), { source: 'loop', step: 1, parents: {} });
    await saver.putWrites(
      { configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'dc1' } },
      [['ch', 'v']],
      'task-del',
    );

    await saver.deleteThread(threadId);

    const doc = DynamoDBDocument.from(admin);
    const remaining = await doc.query({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': partitionKey(threadId) },
      ConsistentRead: true,
    });
    expect(remaining.Items ?? []).toHaveLength(0);
  });

  it('stamps a uniform ttl across meta, payload, and write items when ttl is configured', async () => {
    const ttlSaver = new DynamoDBSaver({ tableName, clientConfig, ttl: { seconds: 3600 } });
    const threadId = 'ttl-checkpoint';
    const config = { configurable: { thread_id: threadId, checkpoint_ns: '' } };
    await ttlSaver.put(config, checkpoint('ttlc1'), { source: 'loop', step: 1, parents: {} });
    await ttlSaver.putWrites(
      { configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'ttlc1' } },
      [['ch', 'v']],
      'task-ttl',
    );
    ttlSaver.destroy();

    const doc = DynamoDBDocument.from(admin);
    const items = await doc.query({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': partitionKey(threadId) },
    });
    const ttls = new Set((items.Items ?? []).map((it) => it.ttl));
    expect(items.Items).toHaveLength(3);
    expect(ttls.size).toBe(1);
    expect([...ttls][0]).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it('putWrites is first-write-wins: a repeated write to the same index keeps the original', async () => {
    const threadId = 'first-write-wins';
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_ns: '' } },
      checkpoint('fwc1'),
      { source: 'loop', step: 1, parents: {} },
    );
    const writeConfig = {
      configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'fwc1' },
    };
    await saver.putWrites(writeConfig, [['ch', 'first']], 'task-fww');
    await saver.putWrites(writeConfig, [['ch', 'second']], 'task-fww');

    const tuple = await saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_id: 'fwc1' },
    });
    expect(tuple?.pendingWrites).toEqual([['task-fww', 'ch', 'first']]);
  });

  it('putWrites special writes (e.g. __error__) always overwrite on repeat', async () => {
    const threadId = 'special-write';
    await saver.put(
      { configurable: { thread_id: threadId, checkpoint_ns: '' } },
      checkpoint('spc1'),
      { source: 'loop', step: 1, parents: {} },
    );
    const writeConfig = {
      configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: 'spc1' },
    };
    await saver.putWrites(writeConfig, [[ERROR, 'first-error']], 'task-special');
    await saver.putWrites(writeConfig, [[ERROR, 'second-error']], 'task-special');

    const tuple = await saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_id: 'spc1' },
    });
    expect(tuple?.pendingWrites).toEqual([['task-special', ERROR, 'second-error']]);
  });

  it('compresses an inline payload and reads it back byte-exact from real DynamoDB', async () => {
    const compressedSaver = new DynamoDBSaver({
      tableName,
      clientConfig,
      compression: { enabled: true },
    });
    const repetitive = 'hello world '.repeat(20000);
    const config = { configurable: { thread_id: 'gzip-thread', checkpoint_ns: '' } };
    const gzipCheckpoint: Checkpoint = {
      v: 4,
      id: 'gz1',
      ts: new Date(0).toISOString(),
      channel_values: { text: repetitive },
      channel_versions: { text: 1 },
      versions_seen: {},
    };
    await compressedSaver.put(config, gzipCheckpoint, { source: 'input', step: 0, parents: {} });

    const doc = DynamoDBDocument.from(admin);
    const raw = await doc.get({
      TableName: tableName,
      Key: { PK: partitionKey('gzip-thread'), SK: payloadSortKey('', 'gz1') },
      ConsistentRead: true,
    });
    const descriptor = raw.Item?.checkpoint as {
      location: string;
      compressed: boolean;
      bytes: Uint8Array;
    };
    expect(descriptor.location).toBe('INLINE');
    expect(descriptor.compressed).toBe(true);
    expect(descriptor.bytes.length).toBeLessThan(repetitive.length / 10);

    const tuple = await compressedSaver.getTuple({
      configurable: { thread_id: 'gzip-thread', checkpoint_ns: '', checkpoint_id: 'gz1' },
    });
    compressedSaver.destroy();
    expect(tuple?.checkpoint.channel_values).toEqual({ text: repetitive });
  });

  it('clear deletes every message and the session metadata row', async () => {
    await history.addMessages('clear-session', [new HumanMessage('a'), new HumanMessage('b')]);

    await history.clear('clear-session');

    const doc = DynamoDBDocument.from(admin);
    const remaining = await doc.query({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk',
      ExpressionAttributeValues: { ':pk': sessionPartition('clear-session') },
      ConsistentRead: true,
    });
    expect(remaining.Items ?? []).toHaveLength(0);
  });

  it('reconcileMessageCount repairs a corrupted count from real message rows', async () => {
    await history.addMessages('drift-session', [new HumanMessage('a'), new HumanMessage('b')]);
    const doc = DynamoDBDocument.from(admin);
    await doc.update({
      TableName: tableName,
      Key: { PK: sessionPartition('drift-session'), SK: 'HISTORY#SESSION' },
      UpdateExpression: 'SET #c = :bad',
      ExpressionAttributeNames: { '#c': 'messageCount' },
      ExpressionAttributeValues: { ':bad': 999 },
    });

    const repaired = await history.reconcileMessageCount('drift-session');

    expect(repaired).toBe(2);
    const raw = await doc.get({
      TableName: tableName,
      Key: { PK: sessionPartition('drift-session'), SK: 'HISTORY#SESSION' },
      ConsistentRead: true,
    });
    expect(raw.Item?.messageCount).toBe(2);
  });

  it('store.listNamespaces returns distinct, sorted namespaces', async () => {
    await store.put(['ns', 'listing', 'a'], 'k1', { text: 'x' });
    await store.put(['ns', 'listing', 'b'], 'k2', { text: 'y' });

    const namespaces = await store.listNamespaces({ prefix: ['ns', 'listing'] });

    expect(namespaces).toEqual([
      ['ns', 'listing', 'a'],
      ['ns', 'listing', 'b'],
    ]);
  });

  it('store.search filters items by metadata under a namespace prefix', async () => {
    await store.put(['ns', 'search'], 'active', { status: 'active', text: 'one' });
    await store.put(['ns', 'search'], 'archived', { status: 'archived', text: 'two' });

    const results = await store.search(['ns', 'search'], { filter: { status: 'active' } });

    expect(results.map((r) => r.key)).toEqual(['active']);
  });
});
