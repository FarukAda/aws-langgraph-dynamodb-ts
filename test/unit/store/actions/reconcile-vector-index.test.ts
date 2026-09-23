import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { reconcileVectorIndex } from '../../../../src/store/actions/reconcile-vector-index';
import { buildStoreItem } from '../../../../src/store/internal/item-mapper';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { overlapOffloader } from '../../../shared/helpers/offload-overlap';

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
    const embeddings = {
      embedQuery: jest.fn(),
      embedDocuments: jest.fn((texts: string[]) => texts.map(() => [0.5])),
    };
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
    // The prune re-check confirms the orphan really has no canonical item
    // before its vector is deleted (M11).
    mock.on(GetCommand).resolves({});

    const result = await reconcileVectorIndex(ctx, ['users', 'u1']);

    expect(result).toEqual({ upserted: 2, pruned: 1 });
    expect(backend.upsert).toHaveBeenCalledWith(['users', 'u1'], 'a', [0.5]);
    expect(backend.upsert).toHaveBeenCalledWith(['users', 'u1'], 'b', [0.5]);
    expect(backend.delete).toHaveBeenCalledWith(['users', 'u1'], 'orphan');
  });

  /**
   * More items than one decode batch holds: the flush inside the enumeration
   * must both bound the concurrency and lose nothing, or a reconcile would
   * prune the vectors of the items it failed to carry forward.
   */
  it('decodes more items than one batch, bounded and complete', async () => {
    const { client, mock } = createStrictDocumentMock();
    const { offloader, maxInFlight } = overlapOffloader();
    const embeddings = {
      embedQuery: jest.fn(),
      embedDocuments: jest.fn((texts: string[]) => texts.map(() => [0.5])),
    };
    const backend = {
      upsert: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
    };
    const ctx = context(client, {
      index: { dims: 1, embeddings: embeddings as never },
      vectorBackend: backend,
      offloader: offloader as never,
      readConcurrency: 4,
    });
    const records = [];
    for (let i = 0; i < 10; i++) {
      records.push(
        await buildStoreItem(
          ctx,
          ['users', 'u1'],
          `k${i}`,
          { text: `value${i}` },
          { createdAt: 'c', updatedAt: 'u' },
        ),
      );
    }
    mock.on(QueryCommand).resolves({ Items: records });

    const result = await reconcileVectorIndex(ctx, ['users', 'u1']);

    expect(result).toEqual({ upserted: 10, pruned: 0 });
    expect(backend.upsert).toHaveBeenCalledTimes(10);
    expect(maxInFlight()).toBeGreaterThan(1);
    expect(maxInFlight()).toBeLessThanOrEqual(4);
  });

  it('passes maxScanItems through to the underlying paginated query', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = {
      embedQuery: jest.fn(),
      embedDocuments: jest.fn((texts: string[]) => texts.map(() => [0.5])),
    };
    const backend = { upsert: jest.fn(), delete: jest.fn(), query: jest.fn() };
    const ctx = context(client, {
      index: { dims: 1, embeddings: embeddings as never },
      vectorBackend: backend,
      maxScanItems: 5,
    });
    // 6 items under a 5-item cap must throw `RESULT_TRUNCATED`, proving the
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

describe('reconcileVectorIndex prefix scoping', () => {
  it('skips a row in the same partition whose deeper namespace lies outside the prefix', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = {
      embedQuery: jest.fn(),
      embedDocuments: jest.fn((texts: string[]) => texts.map(() => [0.5])),
    };
    const backend = {
      upsert: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn(),
      query: jest.fn(),
      listKeys: jest.fn().mockResolvedValue([]),
    };
    const ctx = context(client, {
      index: { dims: 1, embeddings: embeddings as never },
      vectorBackend: backend,
    });
    const inside = await buildStoreItem(
      ctx,
      ['users', 'u1'],
      'a',
      { text: 'hello' },
      {
        createdAt: 'c',
        updatedAt: 'u',
      },
    );
    const sibling = await buildStoreItem(
      ctx,
      ['users', 'u10'],
      'a',
      { text: 'other' },
      {
        createdAt: 'c',
        updatedAt: 'u',
      },
    );
    mock.on(QueryCommand).resolves({ Items: [inside, sibling] });
    const result = await reconcileVectorIndex(ctx, ['users', 'u1']);
    expect(result).toEqual({ upserted: 1, pruned: 0 });
    expect(backend.upsert).toHaveBeenCalledTimes(1);
  });
});
