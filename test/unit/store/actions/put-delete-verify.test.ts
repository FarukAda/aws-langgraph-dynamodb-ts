import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { PutOperation } from '@langchain/langgraph-checkpoint';

import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { putItem } from '../../../../src/store/actions/put';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock, rejectRowWrites } from '../../../shared/helpers/ddb-mock';

function context(client: StoreContext['client'], extra?: Partial<StoreContext>): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    vectorScoreDirection: 'relevance',
    ...extra,
  };
}

const inlineDescriptor = {
  location: PayloadLocation.S3,
  serdeType: 'json',
  compressed: false,
  s3Key: 'old.bin',
};

const op = (over: Partial<PutOperation>): PutOperation => ({
  namespace: ['users', 'u1'],
  key: 'profile',
  value: { name: 'Faruk' },
  ...over,
});

function trackingOffloader() {
  return {
    shouldOffload: () => true,
    buildKey: (parts: string[], objectId: string) => [...parts, objectId].join('/'),
    upload: async (key: string) => key,
    deleteBatch: jest.fn().mockResolvedValue([]),
    ownsKey: () => true,
  };
}

/**
 * I4: put() re-verified an ambiguous retry-exhausted write via verifyWriteLanded,
 * but delete() had no equivalent — it just propagated, skipping S3-orphan
 * cleanup and the vector-backend delete even when the row was gone
 * server-side and only the acknowledgement had been lost.
 */
describe('deleteStoreItem ambiguous-failure verification (I4)', () => {
  it('completes vector and S3 cleanup when an ambiguous delete actually landed (I4)', async () => {
    // put() re-verifies an ambiguous retry-exhausted write via verifyWriteLanded;
    // delete() had no equivalent and just propagated, skipping S3-orphan
    // cleanup and the vector-backend delete even when the row was gone
    // server-side and only the acknowledgement was lost.
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(DeleteCommand)
      .rejects(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    // the post-failure verification sees the row gone
    mock.on(GetCommand).resolves({});
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    const offloader = trackingOffloader();
    await expect(
      putItem(
        context(client, { vectorBackend: vectorBackend as never, offloader: offloader as never }),
        op({ value: null }),
      ),
    ).resolves.toBeUndefined();
    expect(vectorBackend.delete).toHaveBeenCalledWith(['users', 'u1'], 'profile');
  });

  it('propagates an ambiguous delete failure when the row is still present (I4)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(DeleteCommand)
      .rejects(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    mock.on(GetCommand).resolves({ Item: { createdAt: 'c', value: inlineDescriptor } });
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    await expect(
      putItem(context(client, { vectorBackend: vectorBackend as never }), op({ value: null })),
    ).rejects.toMatchObject({ code: ErrorCode.RETRY_EXHAUSTED });
    expect(vectorBackend.delete).not.toHaveBeenCalled();
  });

  it('propagates a non-ambiguous delete failure untouched (I4)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(DeleteCommand)
      .rejects(Object.assign(new Error('bad'), { name: 'ValidationException' }));
    const vectorBackend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    await expect(
      putItem(context(client, { vectorBackend: vectorBackend as never }), op({ value: null })),
    ).rejects.toThrow('bad');
    expect(vectorBackend.delete).not.toHaveBeenCalled();
  });
});

/**
 * The put side of the same principle: verifyWriteLanded reported its own failed
 * verification read as a definite "did not land", so a partition that blocked
 * both the put and the read deleted record.value out from under a row that may
 * well be live. Only a *confirmed* non-commit may delete the new upload.
 */
describe('persistRecord ambiguous-failure verification', () => {
  it('does not delete the new S3 object when the verification read cannot answer', async () => {
    const { client, mock } = createStrictDocumentMock();
    // readExisting succeeds (no previous row); the put exhausts its retries,
    // and the read that would classify it fails too.
    mock
      .on(GetCommand)
      .resolvesOnce({})
      .rejects(Object.assign(new Error('read down'), { name: 'ValidationException' }));
    rejectRowWrites(mock, Object.assign(new Error('timeout'), { name: 'ETIMEDOUT' }));
    const offloader = trackingOffloader();
    await expect(
      putItem(context(client, { offloader: offloader as never }), op({})),
    ).rejects.toThrow(/timeout/);
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });

  it('does not delete the new S3 object when the swap re-read fails after a rejected guard', async () => {
    // A ConditionalCheckFailedException often means this call's own put landed
    // and lost its response; readExisting throwing inside putWithRevisionSwap's
    // catch then arrives here with nothing having refuted that commit.
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(GetCommand)
      .resolvesOnce({})
      .rejects(Object.assign(new Error('read down'), { name: 'ValidationException' }));
    /** An offloaded row commits as a transaction, so its guard rejection is a cancellation. */
    mock.on(TransactWriteCommand).rejects(
      Object.assign(new Error('rejected'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      }),
    );
    const offloader = trackingOffloader();
    await expect(
      putItem(context(client, { offloader: offloader as never }), op({})),
    ).rejects.toThrow(/read down/);
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });

  it('still deletes the new S3 object when the verification read confirms the write did not land', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    rejectRowWrites(mock, Object.assign(new Error('bad'), { name: 'ValidationException' }));
    const offloader = trackingOffloader();
    await expect(
      putItem(context(client, { offloader: offloader as never }), op({})),
    ).rejects.toThrow('bad');
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
  });
});

/** The offloaded value a put of `value` commits, captured by letting it land on an empty item. */
async function valueCommittedBy(value: PutOperation['value']): Promise<{ s3Key: string }> {
  const { client, mock } = createStrictDocumentMock();
  let committed: { s3Key: string } | undefined;
  mock.on(GetCommand).resolves({});
  mock
    .on(TransactWriteCommand)
    .callsFake(
      async (input: { TransactItems: { Put: { Item: { value: { s3Key: string } } } }[] }) => {
        committed = input.TransactItems[0].Put.Item.value;
        return {};
      },
    );
  await putItem(context(client, { offloader: trackingOffloader() as never }), op({ value }));
  return committed!;
}

/** Delete the item, whose row DynamoDB hands back holding `removed`, and report what was released. */
async function deleteReturning(removed: object) {
  const { client, mock } = createStrictDocumentMock();
  mock.on(DeleteCommand).resolves({ Attributes: { value: removed } });
  const offloader = trackingOffloader();
  await expect(
    putItem(context(client, { offloader: offloader as never }), op({ value: null })),
  ).resolves.toBeUndefined();
  const deleted = offloader.deleteBatch.mock.calls.flatMap(([keys]) => keys as string[]);
  return { deleted, reads: mock.commandCalls(GetCommand) };
}

/**
 * The timeline of a delete racing a re-put, with every put uploading under its
 * own `rev`:
 *
 * 1. This call deletes the row, and DynamoDB hands back the removed value, which
 *    the put that wrote it uploaded under that put's own `rev`.
 * 2. A racer then puts the same value again. It uploads under its own `rev`
 *    and commits a row naming that object.
 * 3. This call releases the removed object without reading the row.
 *
 * The invariant is that the racer's committed object is never released.
 */
describe('deleteStoreItem releases the removed object without reading the row again', () => {
  it("releases exactly the removed object, which a racer's re-put of the same value does not name", async () => {
    const removed = await valueCommittedBy({ name: 'Faruk' });
    const racer = await valueCommittedBy({ name: 'Faruk' });

    const { deleted, reads } = await deleteReturning(removed);

    expect(racer.s3Key).not.toBe(removed.s3Key);
    expect(deleted).toEqual([removed.s3Key]);
    expect(reads).toHaveLength(0);
  });

  it('releases nothing, and reads nothing, when the removed value was inline', async () => {
    const { deleted, reads } = await deleteReturning({ location: PayloadLocation.INLINE });
    expect(reads).toHaveLength(0);
    expect(deleted).toEqual([]);
  });
});

describe('persistRecord verifies an ambiguous inline overwrite by rev (STORE-13)', () => {
  it('reports success and cleans up the previous offloaded object when the inline put actually landed', async () => {
    const { client, mock } = createStrictDocumentMock();
    let rev: string | undefined;
    mock.on(GetCommand).callsFake((input) =>
      (input.ProjectionExpression as string).includes('#c')
        ? {
            Item: {
              createdAt: 'c',
              rev: 'r0',
              value: { location: PayloadLocation.S3, s3Key: 'old-key.bin' },
            },
          }
        : { Item: { rev } },
    );
    mock.on(PutCommand).callsFake((input) => {
      rev = input.Item.rev as string;
      throw Object.assign(new Error('timeout'), { name: 'ETIMEDOUT' });
    });
    const offloader = { ...trackingOffloader(), shouldOffload: () => false };
    const ctx = context(client, {
      offloader: offloader as never,
      retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    });
    await expect(putItem(ctx, op({}))).resolves.toBeUndefined();
    expect(offloader.deleteBatch).toHaveBeenCalledWith(['old-key.bin']);
  });
});
