import { randomUUID } from 'node:crypto';

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { DynamoDBChatMessageHistory, DynamoDBSaver, DynamoDBStore } from '../../src/index';
import { partitionKey, sortKey } from '../../src/store/internal/keys';

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
const clientConfig = region ? { region } : {};
const tableName = `aws-langgraph-adapterstest-${randomUUID()}`;

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
 * Real-AWS verification of adapter surfaces the other `test/aws/*` suites
 * don't reach: `DynamoDBStore.delete`, the `forSession()` single-session
 * adapter, `DynamoDBChatMessageHistory.addMessage` (singular), the
 * `compression` option on the store and history adapters, and multi-page
 * `list()` traversal against a real, unforced (not artificially capped)
 * DynamoDB Query result set.
 */
describe('Adapter surfaces against real AWS', () => {
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

  it('store.delete removes an item, verified against a raw read', async () => {
    await store.put(['ns', 'del'], 'k1', { text: 'gone soon' });
    await store.delete(['ns', 'del'], 'k1');

    expect(await store.get(['ns', 'del'], 'k1')).toBeNull();
    const doc = DynamoDBDocument.from(admin);
    const raw = await doc.get({
      TableName: tableName,
      Key: { PK: partitionKey(['ns', 'del']), SK: sortKey(['ns', 'del'], 'k1') },
      ConsistentRead: true,
    });
    expect(raw.Item).toBeUndefined();
  });

  it('forSession() reads, writes, and clears only its own session', async () => {
    const session = history.forSession('adapter-session');
    await session.addMessage(new HumanMessage('one'));
    await session.addMessages([new AIMessage('two'), new HumanMessage('three')]);
    expect((await session.getMessages()).map((m) => m.content)).toEqual(['one', 'two', 'three']);

    await history.addMessages('adapter-sibling', [new HumanMessage('other')]);
    expect((await session.getMessages()).map((m) => m.content)).toEqual(['one', 'two', 'three']);

    await session.clear();
    expect(await session.getMessages()).toEqual([]);
    expect((await history.getMessages('adapter-sibling')).map((m) => m.content)).toEqual(['other']);
  });

  it('addMessage (singular) appends one message to a session', async () => {
    await history.addMessage('single-msg-session', new HumanMessage('solo'));
    expect((await history.getMessages('single-msg-session')).map((m) => m.content)).toEqual([
      'solo',
    ]);
  });

  it('compresses history message payloads and reads them back byte-exact', async () => {
    const compressedHistory = new DynamoDBChatMessageHistory({
      tableName,
      clientConfig,
      compression: { enabled: true },
    });
    const repetitive = 'lorem ipsum dolor sit amet '.repeat(3000);
    await compressedHistory.addMessages('gzip-history', [new HumanMessage(repetitive)]);

    const doc = DynamoDBDocument.from(admin);
    const raw = await doc.query({
      TableName: tableName,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :m)',
      ExpressionAttributeValues: { ':pk': 'gzip-history', ':m': 'MSG#' },
      ConsistentRead: true,
    });
    const descriptor = raw.Items?.[0]?.message as {
      location: string;
      compressed: boolean;
      bytes: Uint8Array;
    };
    expect(descriptor.location).toBe('INLINE');
    expect(descriptor.compressed).toBe(true);
    expect(descriptor.bytes.length).toBeLessThan(repetitive.length / 5);

    const messages = await compressedHistory.getMessages('gzip-history');
    compressedHistory.destroy();
    expect(messages[0]?.content).toBe(repetitive);
  });

  it('compresses store values and reads them back byte-exact', async () => {
    const compressedStore = new DynamoDBStore({
      tableName,
      clientConfig,
      compression: { enabled: true },
    });
    const repetitive = 'y'.repeat(50000);
    await compressedStore.put(['gzip', 'ns'], 'k1', { text: repetitive });

    const doc = DynamoDBDocument.from(admin);
    const raw = await doc.get({
      TableName: tableName,
      Key: { PK: partitionKey(['gzip', 'ns']), SK: sortKey(['gzip', 'ns'], 'k1') },
      ConsistentRead: true,
    });
    const descriptor = raw.Item?.value as {
      location: string;
      compressed: boolean;
      bytes: Uint8Array;
    };
    expect(descriptor.location).toBe('INLINE');
    expect(descriptor.compressed).toBe(true);
    expect(descriptor.bytes.length).toBeLessThan(repetitive.length / 5);

    const item = await compressedStore.get(['gzip', 'ns'], 'k1');
    compressedStore.destroy();
    expect(item?.value).toEqual({ text: repetitive });
  });

  it('list() traverses multiple real DynamoDB Query pages without truncation or duplication', async () => {
    const threadId = 'many-checkpoints';
    const config = { configurable: { thread_id: threadId, checkpoint_ns: '' } };
    const bigNote = 'm'.repeat(50 * 1024);
    const count = 30;
    const ids = Array.from({ length: count }, (_unused, i) => `mc${String(i).padStart(3, '0')}`);
    for (const id of ids) {
      const metadata = {
        source: 'loop',
        step: 1,
        parents: {},
        note: bigNote,
      } as unknown as CheckpointMetadata;
      await saver.put(config, checkpoint(id), metadata, {});
    }

    const seen: string[] = [];
    for await (const tuple of saver.list(config)) seen.push(tuple.checkpoint.id);

    expect(seen).toHaveLength(count);
    expect(new Set(seen).size).toBe(count);
    expect(seen).toEqual([...ids].reverse());
  });
});
