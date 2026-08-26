import { BatchWriteCommand, PutCommand } from '@aws-sdk/lib-dynamodb';

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

function conditionalCheckFailed(): Error {
  return Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' });
}

describe('putWrites', () => {
  it('writes one conditional PutCommand per regular write with the right keys', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).resolves({});
    await putWrites(
      context(client),
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [
        ['ch', 'a'],
        ['ch', 'b'],
      ],
      'task-3',
    );
    const calls = mock.commandCalls(PutCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0].args[0].input.Item?.SK).toBe('WRITE##c1#task-3#0000000008');
    expect(calls[1].args[0].input.Item?.SK).toBe('WRITE##c1#task-3#0000000009');
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
    expect(mock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('stamps a ttl attribute on each write item when ttl is configured', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).resolves({});
    const ctx = { ...context(client), ttl: { seconds: 60 } };
    await putWrites(
      ctx,
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [['ch', 'a']],
      'task-1',
    );
    const calls = mock.commandCalls(PutCommand);
    expect(typeof calls[0].args[0].input.Item?.ttl).toBe('number');
  });

  it('rethrows a write failure without cleanup when no offloader is configured', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).rejects(Object.assign(new Error('down'), { name: 'ValidationException' }));
    await expect(
      putWrites(
        context(client),
        { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
        [['ch', 'a']],
        'task-1',
      ),
    ).rejects.toThrow('down');
  });

  it('cleans up offloaded objects when a regular write fails outright', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
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
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    const [keys] = offloader.deleteBatch.mock.calls[0] as [string[]];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^t\/\/c1\/task-1\/write-0\/[^/]+$/);
  });

  it('cleans up only the item that failed, never a sibling that already succeeded', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(PutCommand)
      .resolvesOnce({})
      .rejectsOnce(Object.assign(new Error('down'), { name: 'ValidationException' }));
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
        [
          ['ch', 'a'],
          ['ch', 'b'],
        ],
        'task-1',
      ),
    ).rejects.toThrow('down');
    // The first item's PutCommand already succeeded, so its row is now
    // permanently live: only the second (genuinely failed, never-committed)
    // item's upload may be cleaned up. Deleting the first's would orphan a
    // committed row — the exact corruption class this fix closes.
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    const [keys] = offloader.deleteBatch.mock.calls[0] as [string[]];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^t\/\/c1\/task-1\/write-1\/[^/]+$/);
  });

  it('never cleans up a special item when its batch write fails outright', async () => {
    // Special items share a deterministic key across calls (unlike regular
    // items, which get a per-call nonce). Deleting on a batch failure could
    // strand a row a *previous* call to the same channel already committed —
    // exactly the corruption class this fix closes for regular items too.
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
        [['__error__', 'boom']],
        'task-1',
      ),
    ).rejects.toMatchObject({
      name: 'BatchWriteAllIncompleteError',
      cause: expect.objectContaining({ message: expect.stringContaining('boom') }),
    });
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });

  it('does not throw when a regular write loses the idempotency race on a second call', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).resolvesOnce({}).rejectsOnce(conditionalCheckFailed());
    const config = { configurable: { thread_id: 't', checkpoint_id: 'c1' } };
    await putWrites(context(client), config, [['ch', 'first']], 'task-1');
    // A ConditionalCheckFailedException on the second, re-executed call means
    // the first write already won, which is success, not failure.
    await expect(
      putWrites(context(client), config, [['ch', 'second']], 'task-1'),
    ).resolves.toBeUndefined();
    expect(mock.commandCalls(PutCommand)).toHaveLength(2);
  });

  it('uses unconditional BatchWriteItem for special (negative-index) writes only', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    await putWrites(
      context(client),
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [['__error__', 'boom']],
      'task-1',
    );
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(1);
    expect(mock.commandCalls(PutCommand)).toHaveLength(0);
  });

  it('uses conditional PutCommand for regular (non-negative-index) writes', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).resolves({});
    await putWrites(
      context(client),
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [['ch', 'a']],
      'task-1',
    );
    expect(mock.commandCalls(PutCommand)).toHaveLength(1);
    expect(mock.commandCalls(PutCommand)[0].args[0].input.ConditionExpression).toBe(
      'attribute_not_exists(PK)',
    );
  });

  it('gives each putWrites call its own S3 key for the same logical write (nonce uniqueness)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).resolves({});
    const upload = jest.fn(async (key: string, _bytes: Uint8Array) => key);
    const offloader = {
      shouldOffload: () => true,
      buildKey: (parts: readonly string[]) => parts.join('/'),
      upload,
      deleteBatch: jest.fn().mockResolvedValue([]),
    };
    const ctx = { ...context(client), offloader: offloader as never };
    const config = { configurable: { thread_id: 't', checkpoint_id: 'c1' } };
    await putWrites(ctx, config, [['ch', 'a']], 'task-1');
    await putWrites(ctx, config, [['ch', 'a']], 'task-1');
    expect(upload).toHaveBeenCalledTimes(2);
    // A hardcoded/constant nonce would also satisfy the key-shape regex used
    // elsewhere in this file; this proves two attempts actually diverge.
    const [firstKey] = upload.mock.calls[0] as [string, Uint8Array];
    const [secondKey] = upload.mock.calls[1] as [string, Uint8Array];
    expect(firstKey).not.toBe(secondKey);
  });

  it('dispatches special and regular writes from the same call through their own DynamoDB paths', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    mock.on(PutCommand).resolves({});
    await putWrites(
      context(client),
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [
        ['ch', 'a'],
        ['__error__', 'boom'],
      ],
      'task-1',
    );
    expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(1);
    expect(mock.commandCalls(PutCommand)).toHaveLength(1);
  });

  it('never deletes an S3 object when a regular write loses the conditional-check race', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).rejects(conditionalCheckFailed());
    const offloader = {
      shouldOffload: () => true,
      buildKey: (parts: readonly string[]) => parts.join('/'),
      upload: async (key: string) => key,
      deleteBatch: jest.fn().mockResolvedValue([]),
    };
    const ctx = { ...context(client), offloader: offloader as never };
    await putWrites(
      ctx,
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [['ch', 'a']],
      'task-1',
    );
    // A ConditionalCheckFailedException does NOT prove a competitor won: the
    // very same conditional PutCommand, retried after its response was lost
    // (ETIMEDOUT/NetworkingError — see retry-classifier), hits its OWN
    // just-committed row and fails the condition too. Deleting "our" upload
    // there would strand a live row pointing at a deleted object, so a lost
    // race never triggers an S3 delete. The loser's upload is left behind
    // instead — bounded and non-corrupting.
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });

  it('leaves a lost-race upload alone while still cleaning a genuinely failed sibling', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(PutCommand)
      .rejectsOnce(conditionalCheckFailed())
      .rejectsOnce(Object.assign(new Error('down'), { name: 'ValidationException' }));
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
        [
          ['ch', 'a'],
          ['ch', 'b'],
        ],
        'task-1',
      ),
    ).rejects.toThrow('down');
    // The failure path must not sweep the conditional-check loser in either:
    // only write-1, which provably never reached DynamoDB, is cleaned up.
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    const [keys] = offloader.deleteBatch.mock.calls[0] as [string[]];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^t\/\/c1\/task-1\/write-1\/[^/]+$/);
  });

  it('dedupes duplicate writes to the same special channel by sort key before batching', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
    await putWrites(
      context(client),
      { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
      [
        ['__error__', 'first'],
        ['__error__', 'second'],
      ],
      'task-1',
    );
    const requests = mock.commandCalls(BatchWriteCommand)[0].args[0].input.RequestItems?.ckpt ?? [];
    expect(requests).toHaveLength(1);
  });
});
