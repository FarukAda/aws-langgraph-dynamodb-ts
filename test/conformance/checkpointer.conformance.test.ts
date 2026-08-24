import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import type { Checkpoint, CheckpointMetadata, PendingWrite } from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver } from '../../src/index';

const endpoint = process.env.DDB_LOCAL_ENDPOINT ?? 'http://localhost:8000';
const tableName = 'checkpoints-conformance';
const clientConfig = {
  endpoint,
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
};

const admin = new DynamoDBClient(clientConfig);
let saver: DynamoDBSaver;

function checkpoint(id: string): Checkpoint {
  return {
    v: 4,
    id,
    ts: new Date(0).toISOString(),
    channel_values: {},
    channel_versions: {},
    versions_seen: {},
  };
}

const metadata: CheckpointMetadata = { source: 'loop', step: 1, parents: {} };

function threadConfig(threadId: string, checkpointId?: string) {
  return { configurable: { thread_id: threadId, checkpoint_ns: '', checkpoint_id: checkpointId } };
}

async function writesFor(threadId: string, checkpointId: string): Promise<PendingWrite[]> {
  const tuple = await saver.getTuple({
    configurable: { thread_id: threadId, checkpoint_id: checkpointId },
  });
  return (tuple?.pendingWrites ?? []).map(([, channel, value]) => [channel, value] as PendingWrite);
}

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

describe('DynamoDBSaver conformance: WRITES_IDX_MAP special-write contract', () => {
  it('dedupes a special write at its fixed slot when a task re-emits with a different list shape', async () => {
    const threadId = 'conf-resume';
    await saver.put(threadConfig(threadId), checkpoint('cp-1'), metadata, {});

    await saver.putWrites(
      threadConfig(threadId, 'cp-1'),
      [
        ['regular', { kept: true }],
        ['__interrupt__', { value: 'first' }],
      ],
      'task-1',
    );
    await saver.putWrites(
      threadConfig(threadId, 'cp-1'),
      [['__interrupt__', { value: 'second' }]],
      'task-1',
    );

    const writes = await writesFor(threadId, 'cp-1');
    const interrupts = writes.filter(([channel]) => channel === '__interrupt__');
    const regulars = writes.filter(([channel]) => channel === 'regular');

    expect(interrupts).toHaveLength(1);
    expect(interrupts[0][1]).toEqual({ value: 'second' });
    expect(regulars).toHaveLength(1);
    expect(regulars[0][1]).toEqual({ kept: true });

    await saver.deleteThread(threadId);
  });

  it('orders special writes before regular writes for a task', async () => {
    const threadId = 'conf-order';
    await saver.put(threadConfig(threadId), checkpoint('cp-1'), metadata, {});
    await saver.putWrites(
      threadConfig(threadId, 'cp-1'),
      [
        ['regular', 'r'],
        ['__error__', 'boom'],
      ],
      'task-1',
    );
    const channels = (await writesFor(threadId, 'cp-1')).map(([channel]) => channel);
    expect(channels.indexOf('__error__')).toBeLessThan(channels.indexOf('regular'));
    await saver.deleteThread(threadId);
  });

  it('round-trips a checkpoint, its metadata, and regular pending writes in index order', async () => {
    const threadId = 'conf-roundtrip';
    await saver.put(threadConfig(threadId), checkpoint('cp-1'), metadata, {});
    const writes = Array.from(
      { length: 12 },
      (_unused, index) => [`ch${index}`, `v${index}`] as PendingWrite,
    );
    await saver.putWrites(threadConfig(threadId, 'cp-1'), writes, 'task-1');

    const tuple = await saver.getTuple({
      configurable: { thread_id: threadId, checkpoint_id: 'cp-1' },
    });
    expect(tuple?.metadata).toEqual(metadata);
    expect(tuple?.pendingWrites).toEqual(
      writes.map(([channel, value]) => ['task-1', channel, value]),
    );
    await saver.deleteThread(threadId);
  });

  it('is idempotent for a regular write when a task re-emits with a different value', async () => {
    const threadId = 'conf-idempotent';
    await saver.put(threadConfig(threadId), checkpoint('cp-1'), metadata, {});
    await saver.putWrites(threadConfig(threadId, 'cp-1'), [['channel-a', 'first']], 'task-1');
    await saver.putWrites(threadConfig(threadId, 'cp-1'), [['channel-a', 'second']], 'task-1');
    const writes = await writesFor(threadId, 'cp-1');
    expect(writes).toEqual([['channel-a', 'first']]);
    await saver.deleteThread(threadId);
  });
});
