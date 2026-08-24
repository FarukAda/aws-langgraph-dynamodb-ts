import {
  BatchWriteCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
} from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver } from '../../../src/checkpointer/saver';
import { createStrictDocumentMock } from '../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: async (value: unknown): Promise<[string, Uint8Array]> => [
    'json',
    new TextEncoder().encode(JSON.stringify(value)),
  ],
  loadsTyped: async (_t: string, d: Uint8Array | string): Promise<unknown> =>
    JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d)),
};

const checkpoint: Checkpoint = {
  v: 4,
  id: 'ckpt-1',
  ts: '',
  channel_values: {},
  channel_versions: {},
  versions_seen: {},
};
const metadata: CheckpointMetadata = { source: 'loop', step: 0, parents: {} };

async function drain(gen: AsyncGenerator<CheckpointTuple>): Promise<CheckpointTuple[]> {
  const out: CheckpointTuple[] = [];
  for await (const t of gen) out.push(t);
  return out;
}

describe('DynamoDBSaver', () => {
  it('put delegates to a transactional write and returns the new config', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
    const result = await saver.put({ configurable: { thread_id: 't' } }, checkpoint, metadata, {});
    expect(result.configurable?.checkpoint_id).toBe('ckpt-1');
  });

  it('getTuple returns undefined when nothing is stored', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
    expect(await saver.getTuple({ configurable: { thread_id: 't' } })).toBeUndefined();
  });

  it('list yields nothing for an empty thread', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
    expect(await drain(saver.list({ configurable: { thread_id: 't' } }))).toEqual([]);
  });

  it('putWrites delegates to a conditional put for a regular write', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).resolves({});
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
    await saver.putWrites(
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [['ch', 'v']],
      'task-1',
    );
    expect(mock.commandCalls(PutCommand)).toHaveLength(1);
  });

  it('deleteThread is a no-op when the thread is empty', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
    await saver.deleteThread('t');
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('does not destroy an injected client', () => {
    const { client } = createStrictDocumentMock();
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde });
    expect(() => saver.destroy()).not.toThrow();
  });

  it('destroys the client it owns', () => {
    const destroy = jest.fn();
    const fakeClient = {
      destroy,
      config: {},
      middlewareStack: { clone: () => ({}) },
      send: jest.fn(),
    };
    const saver = new DynamoDBSaver({
      tableName: 'ckpt',
      clientConfig: { region: 'us-east-1' },
      createClient: () => fakeClient as never,
      serde,
    });
    saver.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
