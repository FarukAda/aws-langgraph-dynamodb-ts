import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type {
  ChannelVersions,
  Checkpoint,
  CheckpointMetadata,
} from '@langchain/langgraph-checkpoint';

import { putCheckpoint } from '../../../../src/checkpointer/actions/put';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: (value: unknown): Promise<[string, Uint8Array]> =>
    Promise.resolve(['json', new TextEncoder().encode(JSON.stringify(value))]),
  loadsTyped: (_t: string, d: Uint8Array | string): Promise<unknown> =>
    Promise.resolve(JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d))),
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

function transientTimeout(): Error {
  return Object.assign(new Error('timeout'), { name: 'ETIMEDOUT' });
}

/**
 * A serde that encodes normally except for its `refuseAt`-th value, which it
 * turns into no bytes at all — the refusal `encodePayload` raises for a payload
 * no reader could parse back. Pointed at the *second* value it reaches the
 * metadata, after the checkpoint's own object has already uploaded.
 */
function refusingSerde(refuseAt: number): CheckpointerContext['serde'] {
  let calls = 0;
  return {
    ...serde,
    dumpsTyped: async (value: unknown): Promise<[string, Uint8Array]> => {
      calls += 1;
      return calls === refuseAt ? ['json', new Uint8Array()] : serde.dumpsTyped(value);
    },
  };
}

function trackingOffloader() {
  return {
    shouldOffload: () => true,
    buildKey: (parts: readonly string[], objectId: string) => [...parts, objectId].join('/'),
    upload: (key: string) => key,
    deleteBatch: jest.fn().mockResolvedValue([]),
  };
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

  it('releases the checkpoint object when the metadata payload is refused', async () => {
    const { client, mock } = createStrictDocumentMock();
    const offloader = trackingOffloader();
    const ctx = {
      ...contextWith(client),
      serde: refusingSerde(2),
      offloader: offloader as never,
    };
    await expect(
      putCheckpoint(ctx, { configurable: { thread_id: 't1' } }, checkpoint, metadata),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'value' } });
    // The checkpoint uploaded, the metadata was refused, and no row names
    // either: the object must not survive the call it was uploaded for.
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    const [keys] = offloader.deleteBatch.mock.calls[0] as [string[]];
    expect(keys).toEqual([expect.stringMatching(/^t1\/\/ckpt-1\/checkpoint\/[^/]+$/)]);
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('still reports the refusal when releasing the object fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    const offloader = trackingOffloader();
    offloader.deleteBatch.mockRejectedValue(
      Object.assign(new Error('denied'), { name: 'AccessDenied' }),
    );
    const ctx = { ...contextWith(client), serde: refusingSerde(2), offloader: offloader as never };
    // The release is best-effort: a caller needs to see why its payload was
    // refused, not why a cleanup could not finish.
    await expect(
      putCheckpoint(ctx, { configurable: { thread_id: 't1' } }, checkpoint, metadata),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'value' } });
    // Asserted, not assumed: the refusal reaches the caller just as well when
    // no release was attempted, so without this the test could not fail for
    // the reason it exists.
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
  });

  it('rethrows a refused payload untouched when no offloader is configured', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = { ...contextWith(client), serde: refusingSerde(2) };
    await expect(
      putCheckpoint(ctx, { configurable: { thread_id: 't1' } }, checkpoint, metadata),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'value' } });
    expect(mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
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

/** The checkpoint the PAYLOAD row of the transaction holds, decoded. */
function storedCheckpoint(mock: ReturnType<typeof createStrictDocumentMock>['mock']): Checkpoint {
  const items = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
  const bytes = items[1].Put?.Item?.checkpoint.bytes as Uint8Array;
  return JSON.parse(new TextDecoder().decode(bytes)) as Checkpoint;
}

const valued: Checkpoint = {
  ...checkpoint,
  channel_values: { foo: 'bar', baz: 'qux' },
  channel_versions: { foo: 1, baz: 1 },
};

describe('putCheckpoint stores every channel value the checkpoint carries', () => {
  /**
   * The reference saver does not narrow what it stores: `MemorySaver.put` takes
   * three parameters and has no `newVersions` at all
   * (@langchain/langgraph-checkpoint@1.1.5 dist/memory.js:206). This adapter
   * matches that, so `newVersions` cannot change what is written.
   */
  it('stores every value when newVersions names only one channel', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    await putCheckpoint(
      contextWith(client),
      { configurable: { thread_id: 't1' } },
      valued,
      metadata,
      { foo: 1 },
    );
    expect(storedCheckpoint(mock).channel_values).toEqual({ foo: 'bar', baz: 'qux' });
  });

  /**
   * LangGraph passes an empty `newVersions` when forking a checkpoint
   * (`updateState(..., '__copy__')`) and when writing an empty-checkpoint
   * update (@langchain/langgraph@1.4.13 dist/pregel/index.js:668 and :613).
   * Narrowing by it wrote a checkpoint with no channel values at all.
   */
  it('stores every value when newVersions is empty, with and without a parent', async () => {
    for (const configurable of [{ thread_id: 't1' }, { thread_id: 't1', checkpoint_id: 'p' }]) {
      const { client, mock } = createStrictDocumentMock();
      mock.on(TransactWriteCommand).resolves({});
      await putCheckpoint(contextWith(client), { configurable }, valued, metadata, {});
      expect(storedCheckpoint(mock).channel_values).toEqual({ foo: 'bar', baz: 'qux' });
    }
  });

  it('stores every value when newVersions is omitted', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    await putCheckpoint(
      contextWith(client),
      { configurable: { thread_id: 't1', checkpoint_id: 'p' } },
      valued,
      metadata,
    );
    expect(storedCheckpoint(mock).channel_values).toEqual({ foo: 'bar', baz: 'qux' });
  });

  /** The parent read existed only to carry channels forward; nothing needs it now. */
  it('never reads the parent row, whatever newVersions says', async () => {
    const cases: (ChannelVersions | undefined)[] = [undefined, {}, { foo: 1 }];
    for (const versions of cases) {
      const { client, mock } = createStrictDocumentMock();
      mock.on(TransactWriteCommand).resolves({});
      await putCheckpoint(
        contextWith(client),
        { configurable: { thread_id: 't1', checkpoint_id: 'parent-0' } },
        valued,
        metadata,
        versions,
      );
      expect(mock.commandCalls(GetCommand)).toHaveLength(0);
    }
  });

  it('writes no storedChannels attribute on the META row', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    await putCheckpoint(
      contextWith(client),
      { configurable: { thread_id: 't1' } },
      valued,
      metadata,
      { foo: 1 },
    );
    const meta =
      mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems?.[0].Put?.Item;
    expect(meta).not.toHaveProperty('storedChannels');
  });
});
