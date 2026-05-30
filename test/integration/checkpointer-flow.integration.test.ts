import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver } from '../../src/index';

const endpoint = process.env.DDB_LOCAL_ENDPOINT ?? 'http://localhost:8000';
const tableName = 'checkpoints-itest';
const clientConfig = {
  endpoint,
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};

const admin = new DynamoDBClient(clientConfig);
let saver: DynamoDBSaver;

function checkpoint(id: string, message: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date(0).toISOString(),
    channel_values: { messages: [message] },
    channel_versions: { messages: 1 },
    versions_seen: {},
  };
}

const metadata: CheckpointMetadata = { source: 'loop', step: 1, parents: {} };

beforeAll(async () => {
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
  await waitUntilTableExists({ client: admin, maxWaitTime: 30 }, { TableName: tableName });
  saver = new DynamoDBSaver({ tableName, clientConfig });
});

afterAll(async () => {
  saver.destroy();
  await admin.send(new DeleteTableCommand({ TableName: tableName }));
  admin.destroy();
});

describe('DynamoDBSaver end-to-end against real DynamoDB', () => {
  it('saves a checkpoint and resumes it, including pending writes and listing', async () => {
    const thread = { configurable: { thread_id: 'thread-A', checkpoint_ns: '' } };

    const next = await saver.put(thread, checkpoint('ckpt-001', 'hello'), metadata, {});
    expect(next.configurable?.checkpoint_id).toBe('ckpt-001');

    const resumed = await saver.getTuple({ configurable: { thread_id: 'thread-A' } });
    expect(resumed?.checkpoint.id).toBe('ckpt-001');
    expect(resumed?.checkpoint.channel_values).toEqual({ messages: ['hello'] });
    expect(resumed?.metadata).toEqual(metadata);
    expect(resumed?.pendingWrites).toEqual([]);

    await saver.putWrites(
      { configurable: { thread_id: 'thread-A', checkpoint_ns: '', checkpoint_id: 'ckpt-001' } },
      [['messages', 'world']],
      'task-1',
    );
    const withWrites = await saver.getTuple({
      configurable: { thread_id: 'thread-A', checkpoint_id: 'ckpt-001' },
    });
    expect(withWrites?.pendingWrites).toEqual([['task-1', 'messages', 'world']]);

    await saver.put(
      { configurable: { thread_id: 'thread-A', checkpoint_ns: '', checkpoint_id: 'ckpt-001' } },
      checkpoint('ckpt-002', 'again'),
      { source: 'loop', step: 2, parents: {} },
      {},
    );

    const listed = [];
    for await (const tuple of saver.list({ configurable: { thread_id: 'thread-A' } })) {
      listed.push(tuple.checkpoint.id);
    }
    expect(listed).toEqual(['ckpt-002', 'ckpt-001']);

    const latest = await saver.getTuple({ configurable: { thread_id: 'thread-A' } });
    expect(latest?.checkpoint.id).toBe('ckpt-002');
    expect(latest?.parentConfig?.configurable?.checkpoint_id).toBe('ckpt-001');

    await saver.deleteThread('thread-A');
    expect(await saver.getTuple({ configurable: { thread_id: 'thread-A' } })).toBeUndefined();
  });

  it('replays 12 pending writes for a task in numeric index order (not lexicographic)', async () => {
    const thread = { configurable: { thread_id: 'thread-B', checkpoint_ns: '' } };
    await saver.put(thread, checkpoint('ckpt-100', 'start'), metadata, {});

    const writes = Array.from(
      { length: 12 },
      (_unused, index) => [`ch${index}`, `v${index}`] as [string, string],
    );
    await saver.putWrites(
      { configurable: { thread_id: 'thread-B', checkpoint_ns: '', checkpoint_id: 'ckpt-100' } },
      writes,
      'task-1',
    );

    const tuple = await saver.getTuple({
      configurable: { thread_id: 'thread-B', checkpoint_id: 'ckpt-100' },
    });
    expect(tuple?.pendingWrites).toEqual(
      writes.map(([channel, value]) => ['task-1', channel, value]),
    );

    await saver.deleteThread('thread-B');
  });
});
