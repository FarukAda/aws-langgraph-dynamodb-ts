import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { PutOperation } from '@langchain/langgraph-checkpoint';

import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { putItem } from '../../../../src/store/actions/put';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

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
    buildKey: (parts: string[], hash: string) => [...parts, hash].join('/'),
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
    mock.on(PutCommand).rejects(Object.assign(new Error('timeout'), { name: 'ETIMEDOUT' }));
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
    mock
      .on(PutCommand)
      .rejects(Object.assign(new Error('rejected'), { name: 'ConditionalCheckFailedException' }));
    const offloader = trackingOffloader();
    await expect(
      putItem(context(client, { offloader: offloader as never }), op({})),
    ).rejects.toThrow(/read down/);
    expect(offloader.deleteBatch).not.toHaveBeenCalled();
  });

  it('still deletes the new S3 object when the verification read confirms the write did not land', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).rejects(Object.assign(new Error('bad'), { name: 'ValidationException' }));
    const offloader = trackingOffloader();
    await expect(
      putItem(context(client, { offloader: offloader as never }), op({})),
    ).rejects.toThrow('bad');
    expect(offloader.deleteBatch).toHaveBeenCalledTimes(1);
  });
});

/** What the read after a delete answers: a row, no row, or a failure. */
type ReadAnswer = { Item?: Record<string, unknown> } | 'fails';

const K1 = 'users/u1/profile/K1.bin';

/**
 * The timeline of a delete racing a re-put:
 *
 * 1. This call deletes the row, and DynamoDB hands back the removed value, at K1.
 * 2. A racer then puts the same value again. No row exists, so it uploads to K1,
 *    because a key is the hash of the bytes under the row's path, and commits a
 *    row pointing at it.
 * 3. This call releases the removed object, K1.
 *
 * `after` is the answer to the read that follows the delete.
 */
async function deleteThenRead(removed: object, after: ReadAnswer) {
  const { client, mock } = createStrictDocumentMock();
  mock.on(DeleteCommand).resolves({ Attributes: { value: removed } });
  if (after === 'fails') {
    mock
      .on(GetCommand)
      .rejects(Object.assign(new Error('read down'), { name: 'ValidationException' }));
  } else {
    mock.on(GetCommand).resolves(after);
  }
  const offloader = trackingOffloader();
  const debug = jest.fn();
  const ctx = context(client, {
    offloader: offloader as never,
    logger: { ...SILENT_LOGGER, debug },
  });
  await expect(putItem(ctx, op({ value: null }))).resolves.toBeUndefined();
  const deleted = offloader.deleteBatch.mock.calls.flatMap(([keys]) => keys as string[]);
  return { deleted, reads: mock.commandCalls(GetCommand), debug };
}

describe('deleteStoreItem reads the row before releasing the removed object', () => {
  it("keeps the removed object when a racer's re-put names it", async () => {
    const { deleted } = await deleteThenRead(
      { location: PayloadLocation.S3, s3Key: K1 },
      { Item: { rev: 'REV-R', value: { location: PayloadLocation.S3, s3Key: K1 } } },
    );
    expect(deleted).toEqual([]);
  });

  it('deletes the removed object when no row exists after the delete', async () => {
    const { deleted, reads } = await deleteThenRead(
      { location: PayloadLocation.S3, s3Key: K1 },
      {},
    );
    expect(deleted).toEqual([K1]);
    expect(reads).toHaveLength(1);
    expect(reads[0].args[0].input).toMatchObject({
      Key: { PK: 'STORE#users', SK: 'u1#profile' },
      ConsistentRead: true,
    });
  });

  /** A read that establishes nothing licenses nothing: the object is left to the lifecycle rule. */
  it('deletes nothing, and logs at debug, when that read fails', async () => {
    const { deleted, debug } = await deleteThenRead(
      { location: PayloadLocation.S3, s3Key: K1 },
      'fails',
    );
    expect(deleted).toEqual([]);
    expect(debug).toHaveBeenCalledWith(
      'store.delete: the row could not be read back; the removed object is left to the lifecycle rule',
      { namespace: ['users', 'u1'], key: 'profile' },
    );
  });

  it('issues no read when the removed value was inline', async () => {
    const { deleted, reads } = await deleteThenRead({ location: PayloadLocation.INLINE }, 'fails');
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
