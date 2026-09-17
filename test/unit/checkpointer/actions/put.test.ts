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
    buildKey: (parts: readonly string[], hash: string) => [...parts, hash].join('/'),
    upload: async (key: string) => key,
    deleteBatch: jest.fn().mockResolvedValue([]),
  };
}

function transientTimeout(): Error {
  return Object.assign(new Error('timeout'), { name: 'ETIMEDOUT' });
}

type DocumentMock = ReturnType<typeof createStrictDocumentMock>['mock'];

/** The descriptors the failed transaction carried, one per row. */
function attempted(mock: DocumentMock) {
  const items = mock.commandCalls(TransactWriteCommand)[0].args[0].input.TransactItems ?? [];
  return { metadata: items[0].Put?.Item?.metadata, checkpoint: items[1].Put?.Item?.checkpoint };
}

/** What one verification read answers, computed when it is issued; `'fails'` rejects it. */
type Answer = (() => { Item?: Record<string, object> }) | 'fails';

/**
 * Answer the META and PAYLOAD reads by the sort key each names: the two rows
 * are read separately, and each must be answered with its own row.
 */
function answerBySortKey(mock: DocumentMock, meta: Answer, payload: Answer): void {
  mock.on(GetCommand).callsFake(async (input: { Key: { SK: string } }) => {
    const answer = input.Key.SK.startsWith('META#') ? meta : payload;
    if (answer === 'fails') {
      throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    }
    return answer();
  });
}

const absent = () => ({});
const otherS3 = (s3Key: string) => ({ location: 'S3', s3Key });
const fastRetry = { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 };

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

  it('cleans up the objects it uploaded when the write is confirmed not to have landed', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(TransactWriteCommand)
      .rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
    answerBySortKey(mock, absent, absent);
    const offloader = trackingOffloader();
    const context = { ...contextWith(client), offloader: offloader as never };
    await expect(
      putCheckpoint(context, { configurable: { thread_id: 't1' } }, checkpoint, metadata),
    ).rejects.toThrow('boom');
    expect(offloader.deleteBatch).toHaveBeenCalledWith([
      expect.stringMatching(/^t1\/\/ckpt-1\/metadata\/[\w-]{43}$/),
      expect.stringMatching(/^t1\/\/ckpt-1\/checkpoint\/[\w-]{43}$/),
    ]);
  });

  it('keeps the uploads and returns the config when a retried transaction landed but lost its response', async () => {
    // Attempt 1 commits server-side; every re-issue times out at the transport,
    // so the budget is spent on RetryExhaustedError although the rows are live.
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(transientTimeout());
    answerBySortKey(
      mock,
      () => ({ Item: { metadata: attempted(mock).metadata } }),
      () => ({ Item: { checkpoint: attempted(mock).checkpoint } }),
    );
    const offloader = trackingOffloader();
    const context = { ...contextWith(client), offloader: offloader as never };
    await expect(
      putCheckpoint(context, { configurable: { thread_id: 't1' } }, checkpoint, metadata),
    ).resolves.toEqual({
      configurable: { thread_id: 't1', checkpoint_ns: '', checkpoint_id: 'ckpt-1' },
    });
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });

  it("cleans up its own uploads when the rows hold another attempt's descriptors after retry exhaustion", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(transientTimeout());
    answerBySortKey(
      mock,
      () => ({ Item: { metadata: otherS3('other-meta') } }),
      () => ({ Item: { checkpoint: otherS3('other-ckpt') } }),
    );
    const offloader = trackingOffloader();
    const context = { ...contextWith(client), offloader: offloader as never, retry: fastRetry };
    await expect(
      putCheckpoint(context, { configurable: { thread_id: 't1' } }, checkpoint, metadata),
    ).rejects.toMatchObject({ code: ErrorCode.RETRY_EXHAUSTED });
    const own = attempted(mock);
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    expect(offloader.deleteBatch).toHaveBeenCalledWith([own.metadata.s3Key, own.checkpoint.s3Key]);
  });

  /**
   * The timeline of C-02c: another writer committed this checkpoint id with the
   * same checkpoint bytes and different metadata, so its PAYLOAD row names this
   * call's checkpoint key while its META row names a metadata key of its own.
   * This call's transaction spends its retries, and the META row proves it did
   * not land.
   */
  it("keeps the checkpoint object another writer's live PAYLOAD row names, releasing only its own metadata", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(transientTimeout());
    answerBySortKey(
      mock,
      () => ({ Item: { metadata: otherS3('t1//ckpt-1/metadata/KMB') } }),
      () => ({ Item: { checkpoint: attempted(mock).checkpoint } }),
    );
    const offloader = trackingOffloader();
    const context = { ...contextWith(client), offloader: offloader as never, retry: fastRetry };
    await expect(
      putCheckpoint(context, { configurable: { thread_id: 't1' } }, checkpoint, metadata),
    ).rejects.toMatchObject({ code: ErrorCode.RETRY_EXHAUSTED });
    const own = attempted(mock);
    const deleted = offloader.deleteBatch.mock.calls.flatMap(([keys]) => keys as string[]);
    expect(deleted).toEqual([own.metadata.s3Key]);
    expect(deleted).not.toContain(own.checkpoint.s3Key);
  });

  /** One row read proves nothing about what the other row names, so nothing is released. */
  it.each([
    ['META', 'fails', () => ({ Item: { checkpoint: otherS3('other-ckpt') } })],
    ['PAYLOAD', () => ({ Item: { metadata: otherS3('other-meta') } }), 'fails'],
  ] as const)(
    'leaks rather than deletes when the %s verification read fails',
    async (_row, metaAnswer, payloadAnswer) => {
      const { client, mock } = createStrictDocumentMock();
      mock.on(TransactWriteCommand).rejects(transientTimeout());
      answerBySortKey(mock, metaAnswer, payloadAnswer);
      const offloader = trackingOffloader();
      const context = { ...contextWith(client), offloader: offloader as never, retry: fastRetry };
      await expect(
        putCheckpoint(context, { configurable: { thread_id: 't1' } }, checkpoint, metadata),
      ).rejects.toMatchObject({ code: ErrorCode.RETRY_EXHAUSTED });
      expect(offloader.deleteBatch).not.toHaveBeenCalled();
    },
  );

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
