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
    buildKey: (parts: readonly string[], objectId: string) => [...parts, objectId].join('/'),
    upload: async (key: string) => key,
    deleteBatch: jest.fn().mockResolvedValue([]),
  };
}

function transientTimeout(): Error {
  return Object.assign(new Error('timeout'), { name: 'ETIMEDOUT' });
}

type DocumentMock = ReturnType<typeof createStrictDocumentMock>['mock'];

/** The descriptors another put of this checkpoint commits, captured by letting it land. */
async function committedRows(withMetadata: CheckpointMetadata) {
  const { client, mock } = createStrictDocumentMock();
  mock.on(TransactWriteCommand).resolves({});
  const context = { ...contextWith(client), offloader: trackingOffloader() as never };
  await putCheckpoint(context, { configurable: { thread_id: 't1' } }, checkpoint, withMetadata);
  return attempted(mock);
}

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
 * configured: the row carrying an offloaded descriptor is read back, and what
 * it holds decides whether the put succeeded after all and whether this call's
 * uploads may be deleted.
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
    const own = attempted(mock);
    const objectId = own.metadata.s3Key.slice('t1//ckpt-1/metadata/'.length);
    expect(objectId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(offloader.deleteBatch).toHaveBeenCalledWith([
      `t1//ckpt-1/metadata/${objectId}`,
      `t1//ckpt-1/checkpoint/${objectId}`,
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
   * The timeline of C-02c, with every put uploading under its own object id:
   *
   * 1. Another put committed this checkpoint id with the same checkpoint bytes
   *    and different metadata. Its rows name objects under its own id.
   * 2. This call's transaction spends its retries.
   * 3. The META row it reads back holds the other put's key, so this call did
   *    not land, and it releases both of its uploads.
   *
   * The invariant is that the other put's committed objects are never released,
   * and the PAYLOAD row is not read to learn that.
   */
  it("releases both of its own uploads, never the objects another put's committed rows name", async () => {
    const other = await committedRows({ ...metadata, source: 'update' });
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).rejects(transientTimeout());
    answerBySortKey(mock, () => ({ Item: { metadata: other.metadata } }), 'fails');
    const offloader = trackingOffloader();
    const context = { ...contextWith(client), offloader: offloader as never, retry: fastRetry };
    await expect(
      putCheckpoint(context, { configurable: { thread_id: 't1' } }, checkpoint, metadata),
    ).rejects.toMatchObject({ code: ErrorCode.RETRY_EXHAUSTED, name: 'RetryExhaustedError' });
    const own = attempted(mock);
    const deleted = offloader.deleteBatch.mock.calls.flatMap(([keys]) => keys as string[]);
    expect(deleted).toEqual([own.metadata.s3Key, own.checkpoint.s3Key]);
    expect(deleted).not.toContain(other.metadata.s3Key);
    expect(deleted).not.toContain(other.checkpoint.s3Key);
    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
  });

  /**
   * A failed read of the row carrying an offloaded descriptor establishes
   * nothing: the transaction's own error is thrown and nothing is deleted.
   */
  it.each<[string, boolean, (mock: DocumentMock) => [Answer, Answer]]>([
    ['the probed META read fails', true, () => ['fails', theirCheckpoint]],
    ['the probed PAYLOAD read fails', false, () => [theirMetadata, 'fails']],
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
   * The row carrying an offloaded descriptor proves a landing on its own: the
   * other row commits with it, so it is not read, and a read of it that would
   * fail cannot turn a committed transaction into a reported failure.
   */
  it.each<[string, boolean, (mock: DocumentMock) => [Answer, Answer]]>([
    [
      'META proves the landing, reading no PAYLOAD row',
      true,
      (mock) => [ownMetadata(mock), 'fails'],
    ],
    [
      'PAYLOAD proves the landing, reading no META row',
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
    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
  });
});

/**
 * An earlier put committed this checkpoint id. A second put of the same
 * checkpoint bytes with different metadata is refused permanently, and the row
 * read back is the earlier put's. It names the earlier put's object, not this
 * call's, so the refusal is reported and only this call's upload is released.
 */
describe('putCheckpoint re-putting a committed checkpoint id', () => {
  it('reports a permanent failure although the PAYLOAD row holds the same bytes', async () => {
    const { client, mock } = createStrictDocumentMock();
    const table = new Map<string, Record<string, unknown>>();
    mock
      .on(TransactWriteCommand)
      .callsFakeOnce(async (input: { TransactItems: { Put: { Item: { SK: string } } }[] }) => {
        for (const { Put } of input.TransactItems) table.set(Put.Item.SK, Put.Item);
        return {};
      })
      .rejects(Object.assign(new Error('refused'), { name: 'ValidationException' }));
    mock.on(GetCommand).callsFake(async (input: { Key: { SK: string } }) => ({
      Item: table.get(input.Key.SK),
    }));
    const offloader = trackingOffloader(false);
    const context = { ...contextWith(client), offloader: offloader as never };
    const config = { configurable: { thread_id: 't1' } };
    await putCheckpoint(context, config, checkpoint, metadata);
    const earlier = table.get('PAYLOAD##ckpt-1')?.checkpoint as { s3Key: string };

    const settled = await putCheckpoint(context, config, checkpoint, {
      ...metadata,
      source: 'update',
    }).catch((error: Error) => error);

    expect(settled).toMatchObject({ name: 'ValidationException', message: 'refused' });
    const own = mock.commandCalls(TransactWriteCommand)[1].args[0].input.TransactItems ?? [];
    const ownKey = (own[1].Put?.Item?.checkpoint as { s3Key: string }).s3Key;
    expect(ownKey).not.toBe(earlier.s3Key);
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
    expect(offloader.deleteBatch).toHaveBeenCalledWith([ownKey]);
  });
});
