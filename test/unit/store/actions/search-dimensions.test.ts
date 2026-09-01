import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { searchItems } from '../../../../src/store/actions/search';
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
    vectorScoreDirection: 'relevance',
    ...extra,
  };
}

describe('searchItems embedding dimensions (STORE-11)', () => {
  it('warns once when stored embeddings do not match the query vector dimension', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0, 1]) };
    const warn = jest.fn();
    const ctx = context(client, {
      index: { dims: 2, embeddings: embeddings as never },
      logger: { ...SILENT_LOGGER, warn },
    });
    // Both items were embedded by a 3-dimensional model; the query is 2-dimensional.
    const meta = { createdAt: 'c', updatedAt: 'u', embedding: [1, 0, 0] };
    const stale1 = await buildStoreItem(ctx, ['users', 'u1'], 's1', { v: 1 }, meta);
    const stale2 = await buildStoreItem(ctx, ['users', 'u1'], 's2', { v: 2 }, meta);
    mock.on(QueryCommand).resolves({ Items: [stale1, stale2] });

    const items = await searchItems(ctx, { namespacePrefix: ['users'], query: 'q' });

    expect(items.every((i) => i.score === undefined)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dimension'),
      expect.objectContaining({ namespacePrefix: ['users'], count: 2 }),
    );
  });

  it('does not warn when every stored embedding matches the query dimension', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0, 1]) };
    const warn = jest.fn();
    const ctx = context(client, {
      index: { dims: 2, embeddings: embeddings as never },
      logger: { ...SILENT_LOGGER, warn },
    });
    const meta = { createdAt: 'c', updatedAt: 'u', embedding: [1, 0] };
    const fresh = await buildStoreItem(ctx, ['users', 'u1'], 'f', { v: 1 }, meta);
    mock.on(QueryCommand).resolves({ Items: [fresh] });

    await searchItems(ctx, { namespacePrefix: ['users'], query: 'q' });

    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects a query vector whose length disagrees with index.dims', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([1, 2, 3]) };
    const ctx = context(client, { index: { dims: 2, embeddings: embeddings as never } });
    mock.on(QueryCommand).resolves({ Items: [] });

    await expect(
      searchItems(ctx, { namespacePrefix: ['users'], query: 'q' }),
    ).rejects.toMatchObject({ name: 'ValidationError', message: expect.stringContaining('dims') });
  });
});
