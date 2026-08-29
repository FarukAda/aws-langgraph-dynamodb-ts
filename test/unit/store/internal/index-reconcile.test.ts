import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import {
  collectReconcileTargets,
  pruneOrphans,
  pushEmbeddings,
  selectOrphans,
} from '../../../../src/store/internal/index-reconcile';
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

describe('selectOrphans', () => {
  it('returns backend refs that have no live canonical target', () => {
    const live = [
      { namespace: ['users', 'u1'], key: 'a', embedding: [1] },
      { namespace: ['users', 'u1'], key: 'b', embedding: undefined },
    ];
    const backendRefs = [
      { namespace: ['users', 'u1'], key: 'a' },
      { namespace: ['users', 'u1'], key: 'gone' },
    ];
    expect(selectOrphans(backendRefs, live)).toEqual([{ namespace: ['users', 'u1'], key: 'gone' }]);
  });

  it('treats the same key under different namespaces as distinct', () => {
    const live = [{ namespace: ['a'], key: 'k', embedding: [1] }];
    const backendRefs = [{ namespace: ['b'], key: 'k' }];
    expect(selectOrphans(backendRefs, live)).toEqual([{ namespace: ['b'], key: 'k' }]);
  });

  it('does not collide a multi-element namespace with a single element containing the separator', () => {
    const live = [{ namespace: ['a', 'b'], key: 'c', embedding: [1] }];
    const backendRefs = [{ namespace: ['a b'], key: 'c' }];
    expect(selectOrphans(backendRefs, live)).toEqual([{ namespace: ['a b'], key: 'c' }]);
  });

  it('treats a live item whose current embedding is undefined as orphan-eligible (empty-text drift)', () => {
    const live = [{ namespace: ['n'], key: 'emptied', embedding: undefined }];
    const backendRefs = [{ namespace: ['n'], key: 'emptied' }];
    expect(selectOrphans(backendRefs, live)).toEqual([{ namespace: ['n'], key: 'emptied' }]);
  });
});

describe('pushEmbeddings', () => {
  it('upserts only targets that have an embedding', async () => {
    const backend = {
      upsert: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn(),
      query: jest.fn(),
    };
    const count = await pushEmbeddings(backend, [
      { namespace: ['n'], key: 'a', embedding: [1] },
      { namespace: ['n'], key: 'b', embedding: undefined },
    ]);
    expect(count).toBe(1);
    expect(backend.upsert).toHaveBeenCalledTimes(1);
    expect(backend.upsert).toHaveBeenCalledWith(['n'], 'a', [1]);
  });
});

describe('pruneOrphans', () => {
  it('returns 0 and logs when the backend has no listKeys', async () => {
    const backend = { upsert: jest.fn(), delete: jest.fn(), query: jest.fn() };
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const count = await pruneOrphans(context(undefined as never, { logger }), backend, ['n'], []);
    expect(count).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('prune skipped'), {
      prefix: ['n'],
    });
  });

  it('deletes backend refs with no live target', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    const backend = {
      upsert: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
      listKeys: jest.fn().mockResolvedValue([
        { namespace: ['n'], key: 'live' },
        { namespace: ['n'], key: 'dead' },
      ]),
    };
    const count = await pruneOrphans(
      context(client),
      backend,
      ['n'],
      [{ namespace: ['n'], key: 'live', embedding: [1] }],
    );
    expect(count).toBe(1);
    expect(backend.delete).toHaveBeenCalledWith(['n'], 'dead');
    expect(backend.listKeys).toHaveBeenCalledWith(['n']);
  });

  it('re-checks a candidate against DynamoDB before pruning it (M11)', async () => {
    // The live-set snapshot and this prune read are not one point in time, so
    // a key written between them looks orphaned. Deleting its vector on that
    // basis silently drops a just-written live item out of semantic search.
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { value: { location: 'INLINE' } } });
    const backend = {
      upsert: jest.fn(),
      delete: jest.fn().mockResolvedValue(undefined),
      query: jest.fn(),
      listKeys: jest
        .fn()
        .mockResolvedValue([{ namespace: ['n'], key: 'written-during-reconcile' }]),
    };
    const count = await pruneOrphans(context(client), backend, ['n'], []);
    expect(count).toBe(0);
    expect(backend.delete).not.toHaveBeenCalled();
  });
});

describe('collectReconcileTargets', () => {
  it('enumerates canonical items under the prefix and recomputes each embedding', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0.5]) };
    const ctx = context(client, { index: { dims: 1, embeddings: embeddings as never } });
    const record = await buildStoreItem(
      ctx,
      ['users', 'u1'],
      'a',
      { text: 'hello' },
      { createdAt: 'c', updatedAt: 'u' },
    );
    mock.on(QueryCommand).resolves({ Items: [record] });

    const targets = await collectReconcileTargets(ctx, ['users', 'u1']);

    expect(targets).toEqual([{ namespace: ['users', 'u1'], key: 'a', embedding: [0.5] }]);
    expect(embeddings.embedQuery).toHaveBeenCalledTimes(1);
  });

  it('skips records that do not match the prefix element-wise', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0.5]) };
    const ctx = context(client, { index: { dims: 1, embeddings: embeddings as never } });
    const match = await buildStoreItem(
      ctx,
      ['users', 'u1'],
      'a',
      { text: 'hi' },
      { createdAt: 'c', updatedAt: 'u' },
    );
    const sibling = { ...match, namespace: ['users', 'u10'] };
    mock.on(QueryCommand).resolves({ Items: [match, sibling] });

    const targets = await collectReconcileTargets(ctx, ['users', 'u1']);
    expect(targets.map((t) => t.namespace)).toEqual([['users', 'u1']]);
  });

  it('skips and warns on a foreign row instead of casting it (F8)', async () => {
    const { client, mock } = createStrictDocumentMock();
    const warn = jest.fn();
    const ctx = context(client, { logger: { ...SILENT_LOGGER, warn } });
    // A row whose `namespace` is truthy but not an array — the exact shape the
    // shared narrowing helper exists to reject, and which a raw cast waves through.
    mock.on(QueryCommand).resolves({
      Items: [{ PK: 'STORE#n', SK: 'foreign', namespace: 'not-an-array', key: 'k' }],
    });

    await expect(collectReconcileTargets(ctx, ['n'])).resolves.toEqual([]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('skipped a row'),
      expect.objectContaining({ sortKey: 'foreign' }),
    );
  });
});
