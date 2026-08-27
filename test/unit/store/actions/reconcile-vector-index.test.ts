import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { reconcileVectorIndex } from '../../../../src/store/actions/reconcile-vector-index';
import { buildStoreItem } from '../../../../src/store/internal/item-mapper';
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

describe('reconcileVectorIndex', () => {
  it('rejects when index or vectorBackend is not configured', async () => {
    const { client } = createStrictDocumentMock();
    await expect(reconcileVectorIndex(context(client), ['n'])).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
    });
  });

  it('rejects an empty namespace prefix', async () => {
    const { client } = createStrictDocumentMock();
    const backend = { upsert: jest.fn(), delete: jest.fn(), query: jest.fn() };
    await expect(
      reconcileVectorIndex(
        context(client, {
          index: { dims: 1, embeddings: { embedQuery: jest.fn() } as never },
          vectorBackend: backend,
        }),
        [],
      ),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION });
  });

  it('re-pushes live embeddings and prunes orphaned vectors', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0.5]) };
    const backend = {
      upsert: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
      listKeys: jest.fn().mockResolvedValue([
        { namespace: ['users', 'u1'], key: 'a' },
        { namespace: ['users', 'u1'], key: 'orphan' },
      ]),
    };
    const ctx = context(client, {
      index: { dims: 1, embeddings: embeddings as never },
      vectorBackend: backend,
    });
    const recordA = await buildStoreItem(
      ctx,
      ['users', 'u1'],
      'a',
      { text: 'hello' },
      { createdAt: 'c', updatedAt: 'u' },
    );
    const recordB = await buildStoreItem(
      ctx,
      ['users', 'u1'],
      'b',
      { text: 'world' },
      { createdAt: 'c', updatedAt: 'u' },
    );
    mock.on(QueryCommand).resolves({ Items: [recordA, recordB] });

    const result = await reconcileVectorIndex(ctx, ['users', 'u1']);

    expect(result).toEqual({ upserted: 2, pruned: 1 });
    expect(backend.upsert).toHaveBeenCalledWith(['users', 'u1'], 'a', [0.5]);
    expect(backend.upsert).toHaveBeenCalledWith(['users', 'u1'], 'b', [0.5]);
    expect(backend.delete).toHaveBeenCalledWith(['users', 'u1'], 'orphan');
  });

  it('passes maxScanItems through to the underlying paginated query', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0.5]) };
    const backend = { upsert: jest.fn(), delete: jest.fn(), query: jest.fn() };
    const ctx = context(client, {
      index: { dims: 1, embeddings: embeddings as never },
      vectorBackend: backend,
      maxScanItems: 5,
    });
    // 6 items under a 5-item cap must throw ResultTruncatedError, proving the
    // configured cap (not the old unconfigurable 10,000 default) is in effect.
    const records = [];
    for (let i = 0; i < 6; i++) {
      const record = await buildStoreItem(
        ctx,
        ['users', 'u1'],
        `k${i}`,
        { text: `value${i}` },
        { createdAt: 'c', updatedAt: 'u' },
      );
      records.push(record);
    }
    mock.on(QueryCommand).resolves({ Items: records });
    await expect(reconcileVectorIndex(ctx, ['users', 'u1'])).rejects.toMatchObject({
      code: ErrorCode.RESULT_TRUNCATED,
    });
  });
});
