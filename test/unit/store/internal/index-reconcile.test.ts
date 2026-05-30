import { QueryCommand } from '@aws-sdk/lib-dynamodb';

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
      context(undefined as never),
      backend,
      ['n'],
      [{ namespace: ['n'], key: 'live', embedding: [1] }],
    );
    expect(count).toBe(1);
    expect(backend.delete).toHaveBeenCalledWith(['n'], 'dead');
    expect(backend.listKeys).toHaveBeenCalledWith(['n']);
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
});
