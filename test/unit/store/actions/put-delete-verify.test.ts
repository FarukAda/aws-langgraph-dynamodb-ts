import { DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
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
    buildKey: (parts: string[]) => parts.join('/'),
    upload: async (key: string) => key,
    deleteBatch: jest.fn().mockResolvedValue([]),
  };
}

/**
 * I4: put() re-verified an ambiguous retry-exhausted write via writeLandedAt,
 * but delete() had no equivalent — it just propagated, skipping S3-orphan
 * cleanup and the vector-backend delete even when the row was gone
 * server-side and only the acknowledgement had been lost.
 */
describe('deleteStoreItem ambiguous-failure verification (I4)', () => {
  it('completes vector and S3 cleanup when an ambiguous delete actually landed (I4)', async () => {
    // put() re-verifies an ambiguous retry-exhausted write via writeLandedAt;
    // delete() had no equivalent and just propagated, skipping S3-orphan
    // cleanup and the vector-backend delete even when the row was gone
    // server-side and only the acknowledgement was lost.
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(DeleteCommand)
      .rejects(Object.assign(new Error('throttled'), { name: 'ThrottlingException' }));
    // readExisting sees the old row; the post-failure verification sees it gone.
    mock
      .on(GetCommand)
      .resolvesOnce({ Item: { createdAt: 'c', value: inlineDescriptor } })
      .resolves({});
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
