import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { putCheckpoint } from '../../../../src/checkpointer/actions/put';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

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
  ts: '2024-01-01T00:00:00.000Z',
  channel_values: {},
  channel_versions: {},
  versions_seen: {},
};
const metadata: CheckpointMetadata = { source: 'loop', step: 0, parents: {} };

function contextWith(client: CheckpointerContext['client']): CheckpointerContext {
  return { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER };
}

describe('putCheckpoint', () => {
  it('transactionally writes the META and PAYLOAD items and returns the new config', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const result = await putCheckpoint(
      contextWith(client),
      { configurable: { thread_id: 't1', checkpoint_id: 'parent-0' } },
      checkpoint,
      metadata,
    );
    expect(result).toEqual({
      configurable: { thread_id: 't1', checkpoint_ns: '', checkpoint_id: 'ckpt-1' },
    });
    const call = mock.commandCalls(TransactWriteCommand)[0];
    const items = call.args[0].input.TransactItems ?? [];
    expect(items).toHaveLength(2);
    expect(items[0].Put?.Item?.SK).toBe('META##ckpt-1');
    expect(items[0].Put?.Item?.parentCheckpointId).toBe('parent-0');
    expect(items[1].Put?.Item?.SK).toBe('PAYLOAD##ckpt-1');
  });

  it('propagates a write failure', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .rejects(Object.assign(new Error('nope'), { name: 'ValidationException' }));
    await expect(
      putCheckpoint(
        contextWith(client),
        { configurable: { thread_id: 't1' } },
        checkpoint,
        metadata,
      ),
    ).rejects.toThrow('nope');
  });

  it('cleans up offloaded S3 objects when the write fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
    const offloader = {
      shouldOffload: () => true,
      buildKey: (parts: readonly string[]) => parts.join('/'),
      upload: async (key: string) => key,
      deleteBatch: jest.fn().mockResolvedValue([]),
    };
    const context = { ...contextWith(client), offloader: offloader as never };
    await expect(
      putCheckpoint(context, { configurable: { thread_id: 't1' } }, checkpoint, metadata),
    ).rejects.toThrow('boom');
    expect(offloader.deleteBatch).toHaveBeenCalledWith([
      't1//ckpt-1/metadata',
      't1//ckpt-1/checkpoint',
    ]);
  });

  it('stamps a ttl attribute on both items when ttl is configured', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const context = { ...contextWith(client), ttl: { seconds: 100 } };
    await putCheckpoint(context, { configurable: { thread_id: 't1' } }, checkpoint, metadata);
    const items = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
    expect(typeof items[0].Put?.Item?.ttl).toBe('number');
    expect(items[1].Put?.Item?.ttl).toBe(items[0].Put?.Item?.ttl);
  });
});
