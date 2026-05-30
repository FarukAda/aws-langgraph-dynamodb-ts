import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { HumanMessage } from '@langchain/core/messages';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { type CreatedAdapters, DynamoDBFactory } from '../../src/index';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from './helpers/ddb-local';

const tableName = 'factory-itest';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
let adapters: CreatedAdapters;

function checkpoint(id: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date(0).toISOString(),
    channel_values: { messages: ['hi'] },
    channel_versions: { messages: 1 },
    versions_seen: {},
  };
}

const metadata: CheckpointMetadata = { source: 'loop', step: 1, parents: {} };

beforeAll(async () => {
  await createTable(admin, tableName);
  adapters = new DynamoDBFactory({ clientConfig: DDB_LOCAL_CONFIG }).createAll({
    saver: { tableName },
    store: { tableName },
    history: { tableName },
  });
});

afterAll(async () => {
  adapters.destroy();
  await deleteTable(admin, tableName);
  admin.destroy();
});

describe('DynamoDBFactory.createAll on one shared table', () => {
  it('drives all three adapters against the same table without collisions', async () => {
    const thread = { configurable: { thread_id: 'thread-f', checkpoint_ns: '' } };
    await adapters.saver.put(thread, checkpoint('ckpt-f'), metadata, {});
    expect((await adapters.saver.getTuple(thread))?.checkpoint.id).toBe('ckpt-f');

    await adapters.store.put(['mem', 'u1'], 'k', { value: 42 });
    expect((await adapters.store.get(['mem', 'u1'], 'k'))?.value).toEqual({ value: 42 });

    await adapters.history.addMessages('sess-f', [new HumanMessage('hey')]);
    expect((await adapters.history.getMessages('sess-f')).map((m) => m.content)).toEqual(['hey']);
  });
});
