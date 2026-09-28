import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { MAX_LOGGED_LABELS } from '../../../../src/shared/logging/truncate';
import { searchItems } from '../../../../src/store/actions/search';
import { buildStoreRow } from '../../../../src/store/internal/rows';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { parsedSearch } from '../../../shared/helpers/parsed-inputs';

function context(client: StoreContext['client'], extra?: Partial<StoreContext>): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    maxIterations: 1000,
    vectorScoreDirection: 'relevance',
    ...extra,
  };
}

describe('searchItems embedding dimensions', () => {
  it('warns once when stored embeddings do not match the query vector dimension', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0, 1]) };
    const warn = jest.fn();
    const ctx = context(client, {
      index: { dims: 2, embeddings: embeddings as never },
      logger: { ...SILENT_LOGGER, warn },
    });
    // Both items were embedded by a 3-dimensional model; the query is 2-dimensional.
    const meta = { createdAt: 'c', updatedAt: 'u', embeddings: [[1, 0, 0]] };
    const stale1 = await buildStoreRow(
      ctx,
      { namespace: ['users', 'u1'], key: 's1' },
      { v: 1 },
      meta,
    );
    const stale2 = await buildStoreRow(
      ctx,
      { namespace: ['users', 'u1'], key: 's2' },
      { v: 2 },
      meta,
    );
    mock.on(QueryCommand).resolves({ Items: [stale1, stale2] });

    const items = await searchItems(ctx, parsedSearch({ namespacePrefix: ['users'], query: 'q' }));

    expect(items.every((i) => i.score === undefined)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dimension'),
      expect.objectContaining({ namespacePrefix: ['users'], count: 2 }),
    );
  });

  /**
   * A search prefix is checked label by label and never as a whole: nothing
   * composes it into a key, so unlike a `namespace` and `key` pair it passes
   * no cap on how many labels it holds.
   */
  it('bounds the depth of the namespacePrefix it reports', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0, 1]) };
    const warn = jest.fn();
    const ctx = context(client, {
      index: { dims: 2, embeddings: embeddings as never },
      logger: { ...SILENT_LOGGER, warn },
    });
    const filler = Array.from({ length: MAX_LOGGED_LABELS }, (_unused, at) => `d${at}`);
    const deep = ['users', ...filler];
    const meta = { createdAt: 'c', updatedAt: 'u', embeddings: [[1, 0, 0]] };
    mock.on(QueryCommand).resolves({
      Items: [await buildStoreRow(ctx, { namespace: deep, key: 's1' }, { v: 1 }, meta)],
    });

    await searchItems(ctx, parsedSearch({ namespacePrefix: deep, query: 'q' }));

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('dimension'),
      expect.objectContaining({
        namespacePrefix: [...deep.slice(0, MAX_LOGGED_LABELS), `…(len ${deep.length})`],
      }),
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
    const meta = { createdAt: 'c', updatedAt: 'u', embeddings: [[1, 0]] };
    const fresh = await buildStoreRow(
      ctx,
      { namespace: ['users', 'u1'], key: 'f' },
      { v: 1 },
      meta,
    );
    mock.on(QueryCommand).resolves({ Items: [fresh] });

    const items = await searchItems(ctx, parsedSearch({ namespacePrefix: ['users'], query: 'q' }));

    expect(items[0].score).toBeDefined();
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * Before per-path vectors, a row carried one joined `embedding`. Those rows
   * are still out there and still rank: the reader reads the single vector as
   * a one-element list, so it scores exactly as it did when it was written.
   */
  it('ranks a row that still carries the single joined embedding', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0, 1]) };
    const warn = jest.fn();
    const ctx = context(client, {
      index: { dims: 2, embeddings: embeddings as never },
      logger: { ...SILENT_LOGGER, warn },
    });
    const row = await buildStoreRow(
      ctx,
      { namespace: ['users', 'u1'], key: 'legacy' },
      { v: 1 },
      {
        createdAt: 'c',
        updatedAt: 'u',
      },
    );
    mock.on(QueryCommand).resolves({ Items: [{ ...row, embedding: [0, 1] }] });

    const items = await searchItems(ctx, parsedSearch({ namespacePrefix: ['users'], query: 'q' }));

    expect(items[0].score).toBe(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('rejects a query vector whose length disagrees with index.dims', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([1, 2, 3]) };
    const ctx = context(client, { index: { dims: 2, embeddings: embeddings as never } });
    mock.on(QueryCommand).resolves({ Items: [] });

    await expect(
      searchItems(ctx, parsedSearch({ namespacePrefix: ['users'], query: 'q' })),
    ).rejects.toMatchObject({
      name: 'DynamoDBLangGraphError',
      code: ErrorCode.VALIDATION,
      message: expect.stringContaining('dims'),
    });
  });
});
