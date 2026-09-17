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

/**
 * `offloadMetadata: false` keeps the small metadata inline and offloads only
 * the larger checkpoint, which makes the PAYLOAD row the one probed.
 */
function trackingOffloader(offloadMetadata = true) {
  return {
    shouldOffload: (bytes: Uint8Array) => offloadMetadata || bytes.length > 64,
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
const theirMetadata = () => ({ Item: { metadata: otherS3('other-meta') } });
const theirCheckpoint = () => ({ Item: { checkpoint: otherS3('other-ckpt') } });
const ownMetadata = (mock: DocumentMock) => () => ({
  Item: { metadata: attempted(mock).metadata },
});
const ownCheckpoint = (mock: DocumentMock) => () => ({
  Item: { checkpoint: attempted(mock).checkpoint },
});

/**
 * A put whose transaction spends its retries while each verification read
 * answers as `answers` says, settled either way.
 */
async function failedPut(
  offloadMetadata: boolean,
  answers: (mock: DocumentMock) => [Answer, Answer],
) {
  const { client, mock } = createStrictDocumentMock();
  mock.on(TransactWriteCommand).rejects(transientTimeout());
  answerBySortKey(mock, ...answers(mock));
  const offloader = trackingOffloader(offloadMetadata);
  const debug = jest.fn();
  const context = {
    ...contextWith(client),
    logger: { ...SILENT_LOGGER, debug },
    offloader: offloader as never,
    retry: fastRetry,
  };
  const settled: { value?: Awaited<ReturnType<typeof putCheckpoint>>; error?: Error } =
    await putCheckpoint(context, { configurable: { thread_id: 't1' } }, checkpoint, metadata).then(
      (value) => ({ value }),
      (error: Error) => ({ error }),
    );
  return { mock, offloader, debug, settled };
}

/**
 * What a failed transaction does to this call's uploads when S3 offload is
 * configured: the META and PAYLOAD rows are read back, and what they hold
 * decides whether the put succeeded after all, what may be deleted, and
 * whether anything may be deleted at all.
 */
describe('putCheckpoint after a failed transaction, with S3 offload', () => {
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

  /**
   * A failed probed read establishes nothing, and a row that shows another
   * writer licenses a release only once the other row is known too: it may
   * name the very object that release would delete. Either way the
   * transaction's own error is thrown and nothing is deleted.
   */
  it.each<[string, boolean, (mock: DocumentMock) => [Answer, Answer]]>([
    ['the probed META read fails', true, () => ['fails', theirCheckpoint]],
    ['the probed PAYLOAD read fails', false, () => [theirMetadata, 'fails']],
    ['META shows another writer and the PAYLOAD read fails', true, () => [theirMetadata, 'fails']],
    [
      'PAYLOAD shows another writer and the META read fails',
      false,
      () => ['fails', theirCheckpoint],
    ],
  ])('leaks rather than deletes when %s', async (_case, offloadMetadata, answers) => {
    const { mock, offloader, settled } = await failedPut(offloadMetadata, answers);
    expect(settled.error).toMatchObject({
      code: ErrorCode.RETRY_EXHAUSTED,
      message: expect.stringContaining('timeout'),
    });
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
    expect(attempted(mock).metadata.location).toBe(offloadMetadata ? 'S3' : 'INLINE');
  });

  /**
   * The row carrying an offloaded descriptor proves a landing on its own, and a
   * landing releases nothing, so the other row's failed read cannot turn a
   * committed transaction into a reported failure.
   */
  it.each<[string, boolean, (mock: DocumentMock) => [Answer, Answer]]>([
    [
      'META proves the landing and the PAYLOAD read fails',
      true,
      (mock) => [ownMetadata(mock), 'fails'],
    ],
    [
      'PAYLOAD proves the landing and the META read fails',
      false,
      (mock) => ['fails', ownCheckpoint(mock)],
    ],
  ])('returns the stored config when %s', async (_case, offloadMetadata, answers) => {
    const { mock, offloader, debug, settled } = await failedPut(offloadMetadata, answers);
    expect(settled).toEqual({
      value: { configurable: { thread_id: 't1', checkpoint_ns: '', checkpoint_id: 'ckpt-1' } },
    });
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith(
      'put: transaction committed although its response was lost',
      {
        threadId: 't1',
        checkpointId: 'ckpt-1',
      },
    );
    expect(attempted(mock).metadata.location).toBe(offloadMetadata ? 'S3' : 'INLINE');
  });
});
