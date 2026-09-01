import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { putCheckpoint } from '../../../../src/checkpointer/actions/put';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
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

function trackingOffloader() {
  return {
    shouldOffload: () => true,
    buildKey: (parts: readonly string[]) => parts.join('/'),
    upload: async (key: string) => key,
    deleteBatch: jest.fn().mockResolvedValue([]),
  };
}

function transientTimeout(): Error {
  return Object.assign(new Error('timeout'), { name: 'ETIMEDOUT' });
}

/** The metadata descriptor the transaction tried to write, as the row would hold it. */
function committedMetaRow(mock: ReturnType<typeof createStrictDocumentMock>['mock']) {
  const items = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
  return { Item: { metadata: items[0].Put?.Item?.metadata } };
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

  it('rejects a checkpoint.id containing the reserved separator', async () => {
    const { client } = createStrictDocumentMock();
    await expect(
      putCheckpoint(
        contextWith(client),
        { configurable: { thread_id: 't1' } },
        { ...checkpoint, id: 'ckpt#1' },
        metadata,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION });
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

  it('cleans up its own nonced uploads when the write is confirmed not to have landed', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
    mock.on(GetCommand).resolves({});
    const offloader = trackingOffloader();
    const context = { ...contextWith(client), offloader: offloader as never };
    await expect(
      putCheckpoint(context, { configurable: { thread_id: 't1' } }, checkpoint, metadata),
    ).rejects.toThrow('boom');
    expect(offloader.deleteBatch).toHaveBeenCalledWith([
      expect.stringMatching(/^t1\/\/ckpt-1\/metadata\/[0-9A-HJKMNP-TV-Z]{26}$/),
      expect.stringMatching(/^t1\/\/ckpt-1\/checkpoint\/[0-9A-HJKMNP-TV-Z]{26}$/),
    ]);
  });

  it('keeps the uploads and returns the config when a retried transaction landed but lost its response', async () => {
    // Attempt 1 commits server-side; every re-issue times out at the transport,
    // so the budget is spent on RetryExhaustedError although the rows are live.
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(transientTimeout());
    mock.on(GetCommand).callsFake(async () => committedMetaRow(mock));
    const offloader = trackingOffloader();
    const context = { ...contextWith(client), offloader: offloader as never };
    await expect(
      putCheckpoint(context, { configurable: { thread_id: 't1' } }, checkpoint, metadata),
    ).resolves.toEqual({
      configurable: { thread_id: 't1', checkpoint_ns: '', checkpoint_id: 'ckpt-1' },
    });
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });

  it("cleans up its own uploads when the row holds another attempt's descriptor after retry exhaustion", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(transientTimeout());
    mock.on(GetCommand).resolves({
      Item: { metadata: { location: 'S3', serdeType: 'json', compressed: false, s3Key: 'other' } },
    });
    const offloader = trackingOffloader();
    const context = { ...contextWith(client), offloader: offloader as never };
    await expect(
      putCheckpoint(context, { configurable: { thread_id: 't1' } }, checkpoint, metadata),
    ).rejects.toMatchObject({ code: ErrorCode.RETRY_EXHAUSTED });
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
  });

  it('leaks rather than deletes when the verification read itself fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(transientTimeout());
    mock
      .on(GetCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDeniedException' }));
    const offloader = trackingOffloader();
    const context = { ...contextWith(client), offloader: offloader as never };
    await expect(
      putCheckpoint(context, { configurable: { thread_id: 't1' } }, checkpoint, metadata),
    ).rejects.toMatchObject({ code: ErrorCode.RETRY_EXHAUSTED });
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });

  it('does not read back on failure when no offloader is configured', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(transientTimeout());
    await expect(
      putCheckpoint(
        contextWith(client),
        { configurable: { thread_id: 't1' } },
        checkpoint,
        metadata,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.RETRY_EXHAUSTED });
    expect(mock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('rejects an over-limit checkpoint with a typed error before any write when s3 is not configured (CKPT-03)', async () => {
    const { client, mock } = createStrictDocumentMock();
    const huge: Checkpoint = { ...checkpoint, channel_values: { blob: 'x'.repeat(400 * 1024) } };
    await expect(
      putCheckpoint(contextWith(client), { configurable: { thread_id: 't1' } }, huge, metadata),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'payload' } });
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
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
