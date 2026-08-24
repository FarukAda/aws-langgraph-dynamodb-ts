import { randomUUID } from 'node:crypto';

import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import { AIMessage, HumanMessage } from '@langchain/core/messages';
import type { Checkpoint } from '@langchain/langgraph-checkpoint';

import { DynamoDBFactory } from '../../src/index';

const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
const clientConfig = region ? { region } : {};
const tableName = `aws-langgraph-factorytest-${randomUUID()}`;

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
 * Real-AWS verification that `DynamoDBFactory.createAll`'s shared-client
 * wiring actually works end-to-end: all three adapters read and write
 * correctly through the one client the factory builds, and the combined
 * `destroy()` releases it without error.
 */
describe('DynamoDBFactory.createAll against real AWS', () => {
  let admin: DynamoDBClient;

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
  });

  afterAll(async () => {
    if (admin) {
      await admin.send(new DeleteTableCommand({ TableName: tableName }));
      await waitUntilTableNotExists({ client: admin, maxWaitTime: 90 }, { TableName: tableName });
      admin.destroy();
    }
  });

  it('builds one shared client and every adapter reads/writes through it', async () => {
    const factory = new DynamoDBFactory({ clientConfig });
    const { saver, store, history, destroy } = factory.createAll({
      saver: { tableName },
      store: { tableName },
      history: { tableName },
    });

    await saver.put({ configurable: { thread_id: 'f1', checkpoint_ns: '' } }, checkpoint('fc1'), {
      source: 'loop',
      step: 1,
      parents: {},
    });
    const tuple = await saver.getTuple({ configurable: { thread_id: 'f1', checkpoint_id: 'fc1' } });
    expect(tuple?.checkpoint.id).toBe('fc1');

    await store.put(['factory'], 'k1', { text: 'hello' });
    expect((await store.get(['factory'], 'k1'))?.value).toEqual({ text: 'hello' });

    await history.addMessages('f-session', [new HumanMessage('hi'), new AIMessage('there')]);
    expect((await history.getMessages('f-session')).map((m) => m.content)).toEqual(['hi', 'there']);

    destroy();
  });

  it('createSaver/createStore/createChatMessageHistory each build a working, independent adapter', async () => {
    const factory = new DynamoDBFactory({ clientConfig });

    const saver = factory.createSaver({ tableName });
    await saver.put({ configurable: { thread_id: 'f2', checkpoint_ns: '' } }, checkpoint('fc2'), {
      source: 'loop',
      step: 1,
      parents: {},
    });
    const tuple = await saver.getTuple({ configurable: { thread_id: 'f2', checkpoint_id: 'fc2' } });
    expect(tuple?.checkpoint.id).toBe('fc2');
    saver.destroy();

    const store = factory.createStore({ tableName });
    await store.put(['factory-individual'], 'k1', { text: 'hello again' });
    expect((await store.get(['factory-individual'], 'k1'))?.value).toEqual({ text: 'hello again' });
    store.destroy();

    const history = factory.createChatMessageHistory({ tableName });
    await history.addMessages('f-session-individual', [new HumanMessage('solo build')]);
    expect((await history.getMessages('f-session-individual')).map((m) => m.content)).toEqual([
      'solo build',
    ]);
    history.destroy();
  });
});
