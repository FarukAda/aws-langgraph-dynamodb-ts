import { BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

import { putWrites } from '../../../../src/checkpointer/actions/put-writes';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: async (value: unknown): Promise<[string, Uint8Array]> => [
    'json',
    new TextEncoder().encode(JSON.stringify(value)),
  ],
  loadsTyped: async (): Promise<unknown> => ({}),
};

function context(client: CheckpointerContext['client']): CheckpointerContext {
  return { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER };
}

describe('putWrites', () => {
  it('batch-writes one item per write with the right keys', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    await putWrites(
      context(client),
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [
        ['ch', 'a'],
        ['ch', 'b'],
      ],
      'task-3',
    );
    const requests = mock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems?.ckpt ?? [];
    expect(requests).toHaveLength(2);
    expect(requests[0].PutRequest?.Item?.SK).toBe('WRITE##c1#task-3#0000000000');
    expect(requests[1].PutRequest?.Item?.SK).toBe('WRITE##c1#task-3#0000000001');
  });

  it('rejects a taskId containing the reserved separator', async () => {
    const { client } = createStrictDocumentMock();
    await expect(
      putWrites(
        context(client),
        { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
        [['ch', 'a']],
        'task#1',
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION });
  });

  it('throws VALIDATION when checkpoint_id is missing', async () => {
    const { client } = createStrictDocumentMock();
    try {
      await putWrites(
        context(client),
        { configurable: { thread_id: 't' } },
        [['ch', 'a']],
        'task-1',
      );
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code: ErrorCode }).code).toBe(ErrorCode.VALIDATION);
    }
  });

  it('is a no-op for an empty writes list', async () => {
    const { client, mock } = createStrictDocumentMock();
    await putWrites(
      context(client),
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [],
      'task-1',
    );
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it('stamps a ttl attribute on each write item when ttl is configured', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    const ctx = { ...context(client), ttl: { seconds: 60 } };
    await putWrites(
      ctx,
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [['ch', 'a']],
      'task-1',
    );
    const requests = mock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems?.ckpt ?? [];
    expect(typeof requests[0].PutRequest?.Item?.ttl).toBe('number');
  });

  it('rethrows a write failure without cleanup when no offloader is configured', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(BatchWriteCommand)
      .rejects(Object.assign(new Error('down'), { name: 'ValidationException' }));
    await expect(
      putWrites(
        context(client),
        { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
        [['ch', 'a']],
        'task-1',
      ),
    ).rejects.toThrow('down');
  });

  it('cleans up offloaded objects when the batch write fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(BatchWriteCommand)
      .rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
    const offloader = {
      shouldOffload: () => true,
      buildKey: (parts: readonly string[]) => parts.join('/'),
      upload: async (key: string) => key,
      deleteBatch: jest.fn().mockResolvedValue([]),
    };
    const ctx = { ...context(client), offloader: offloader as never };
    await expect(
      putWrites(
        ctx,
        { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
        [['ch', 'a']],
        'task-1',
      ),
    ).rejects.toThrow('boom');
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['t//c1/task-1/write-0']);
  });
});
