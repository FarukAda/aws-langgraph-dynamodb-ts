import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver } from '../../src/index';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from '../integration/helpers/ddb-local';

const tableName = 'checkpointer-contract';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
let saver: DynamoDBSaver;

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

const metadata: CheckpointMetadata = { source: 'loop', step: 1, parents: {} };

beforeAll(async () => {
  await createTable(admin, tableName);
  saver = new DynamoDBSaver({ tableName, clientConfig: DDB_LOCAL_CONFIG });
});

afterAll(async () => {
  saver.destroy();
  await deleteTable(admin, tableName);
  admin.destroy();
});

describe('BaseCheckpointSaver contract conformance', () => {
  it('put → getTuple → list yields a well-formed CheckpointTuple and newest-by-default', async () => {
    const thread = { configurable: { thread_id: 'c-thread', checkpoint_ns: '' } };
    await saver.put(thread, checkpoint('ck-1'), metadata);
    await saver.put(
      { configurable: { thread_id: 'c-thread', checkpoint_ns: '', checkpoint_id: 'ck-1' } },
      checkpoint('ck-2'),
      { source: 'loop', step: 2, parents: {} },
    );

    const tuple = await saver.getTuple({ configurable: { thread_id: 'c-thread' } });
    expect(tuple?.checkpoint.id).toBe('ck-2');
    expect(tuple?.config.configurable?.checkpoint_id).toBe('ck-2');
    expect(tuple?.metadata).toEqual({ source: 'loop', step: 2, parents: {} });
    expect(tuple?.parentConfig?.configurable?.checkpoint_id).toBe('ck-1');
    expect(Array.isArray(tuple?.pendingWrites)).toBe(true);

    const ids: string[] = [];
    for await (const listed of saver.list({ configurable: { thread_id: 'c-thread' } })) {
      ids.push(listed.checkpoint.id);
    }
    expect(ids).toEqual(['ck-2', 'ck-1']);
  });
});
