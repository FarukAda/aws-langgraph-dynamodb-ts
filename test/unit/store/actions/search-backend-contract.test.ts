import { GetCommand } from '@aws-sdk/lib-dynamodb';

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

describe('searchItems vectorBackend contract (I3, A3)', () => {
  it('warns when a backend returns scores that are not non-increasing (I3)', async () => {
    // The upstream SearchItem.score contract is "higher = better match", and
    // match.score is forwarded verbatim. A backend surfacing a raw *distance*
    // (S3 Vectors, FAISS L2) still returns nearest-first, so the order looks
    // right while every score means the opposite of what a caller thresholding
    // or displaying it expects. Ascending scores are that exact signature.
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0, 1]) };
    const recA = await buildStoreItem(
      context(client),
      ['users', 'u1'],
      'a',
      { score: 1 },
      { createdAt: 'c', updatedAt: 'u' },
    );
    mock.on(GetCommand).resolves({ Item: recA });
    const vectorBackend = {
      upsert: jest.fn(),
      delete: jest.fn(),
      query: jest.fn().mockResolvedValue([
        { namespace: ['users', 'u1'], key: 'a', score: 0.1 },
        { namespace: ['users', 'u1'], key: 'a', score: 0.9 },
      ]),
    };
    const warn = jest.fn();
    const ctx = context(client, {
      index: { dims: 2, embeddings: embeddings as never },
      vectorBackend: vectorBackend as never,
      logger: { ...SILENT_LOGGER, warn },
    });
    await searchItems(ctx, { namespacePrefix: ['users'], query: 'q' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('relevance'),
      expect.objectContaining({ namespacePrefix: ['users'] }),
    );
  });

  it('rejects a query vector whose length disagrees with index.dims before asking the backend', async () => {
    const { client } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([1, 2, 3]) };
    const vectorBackend = { upsert: jest.fn(), delete: jest.fn(), query: jest.fn() };
    const ctx = context(client, {
      index: { dims: 2, embeddings: embeddings as never },
      vectorBackend: vectorBackend as never,
    });
    await expect(
      searchItems(ctx, { namespacePrefix: ['users'], query: 'q' }),
    ).rejects.toMatchObject({ name: 'ValidationError' });
    expect(vectorBackend.query).not.toHaveBeenCalled();
  });

  it('does not warn for a correctly ordered backend (I3)', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0, 1]) };
    const recA = await buildStoreItem(
      context(client),
      ['users', 'u1'],
      'a',
      { score: 1 },
      { createdAt: 'c', updatedAt: 'u' },
    );
    mock.on(GetCommand).resolves({ Item: recA });
    const vectorBackend = {
      upsert: jest.fn(),
      delete: jest.fn(),
      query: jest.fn().mockResolvedValue([
        { namespace: ['users', 'u1'], key: 'a', score: 0.9 },
        { namespace: ['users', 'u1'], key: 'a', score: 0.1 },
      ]),
    };
    const warn = jest.fn();
    const ctx = context(client, {
      index: { dims: 2, embeddings: embeddings as never },
      vectorBackend: vectorBackend as never,
      logger: { ...SILENT_LOGGER, warn },
    });
    await searchItems(ctx, { namespacePrefix: ['users'], query: 'q' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('skips a backend match whose namespace is not a valid store namespace (A3)', async () => {
    // getItem validates, so a backend returning a namespace element containing
    // the reserved separator turned an entire search into a ValidationError
    // instead of dropping the one unusable match.
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0, 1]) };
    const recA = await buildStoreItem(
      context(client),
      ['users', 'u1'],
      'ok',
      { score: 1 },
      { createdAt: 'c', updatedAt: 'u' },
    );
    mock.on(GetCommand).resolves({ Item: recA });
    const vectorBackend = {
      upsert: jest.fn(),
      delete: jest.fn(),
      query: jest.fn().mockResolvedValue([
        { namespace: ['users', 'bad#ns'], key: 'k', score: 0.9 },
        { namespace: ['users', 'u1'], key: 'ok', score: 0.8 },
      ]),
    };
    const warn = jest.fn();
    const ctx = context(client, {
      index: { dims: 2, embeddings: embeddings as never },
      vectorBackend: vectorBackend as never,
      logger: { ...SILENT_LOGGER, warn },
    });
    const items = await searchItems(ctx, { namespacePrefix: ['users'], query: 'q' });
    expect(items.map((i) => i.key)).toEqual(['ok']);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('unusable'),
      expect.objectContaining({ key: 'k' }),
    );
  });
});

describe('vectorScoreDirection (F4)', () => {
  it('does not warn about ascending scores when the backend is declared distance-scored', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0, 1]) };
    const recA = await buildStoreItem(
      context(client),
      ['users', 'u1'],
      'a',
      { score: 1 },
      { createdAt: 'c', updatedAt: 'u' },
    );
    mock.on(GetCommand).resolves({ Item: recA });
    const vectorBackend = {
      upsert: jest.fn(),
      delete: jest.fn(),
      // Ascending scores are exactly the "backwards" signature — but declared.
      query: jest.fn().mockResolvedValue([
        { namespace: ['users', 'u1'], key: 'a', score: 0.1 },
        { namespace: ['users', 'u1'], key: 'b', score: 0.9 },
      ]),
    };
    const warn = jest.fn();
    const ctx = context(client, {
      index: { dims: 2, embeddings: embeddings as never },
      vectorBackend: vectorBackend as never,
      vectorScoreDirection: 'distance',
      logger: { ...SILENT_LOGGER, warn },
    });
    const items = await searchItems(ctx, { namespacePrefix: ['users'], query: 'q' });
    expect(warn).not.toHaveBeenCalledWith(
      expect.stringContaining('ascending scores'),
      expect.anything(),
    );
    expect(items.map((item) => item.score)).toEqual([-0.1, -0.9]);
  });

  it('still warns for an undeclared backend returning ascending scores', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0, 1]) };
    const recA = await buildStoreItem(
      context(client),
      ['users', 'u1'],
      'a',
      { score: 1 },
      { createdAt: 'c', updatedAt: 'u' },
    );
    mock.on(GetCommand).resolves({ Item: recA });
    const vectorBackend = {
      upsert: jest.fn(),
      delete: jest.fn(),
      query: jest.fn().mockResolvedValue([
        { namespace: ['users', 'u1'], key: 'a', score: 0.1 },
        { namespace: ['users', 'u1'], key: 'b', score: 0.9 },
      ]),
    };
    const warn = jest.fn();
    const ctx = context(client, {
      index: { dims: 2, embeddings: embeddings as never },
      vectorBackend: vectorBackend as never,
      vectorScoreDirection: 'relevance',
      logger: { ...SILENT_LOGGER, warn },
    });
    await searchItems(ctx, { namespacePrefix: ['users'], query: 'q' });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('ascending scores'),
      expect.anything(),
    );
  });
});
