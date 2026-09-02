import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ValidationError } from '../../../../src/shared/errors/errors';
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

async function records(ctx: StoreContext) {
  return [
    await buildStoreItem(
      ctx,
      ['users', 'u1'],
      'a',
      { kind: 'note', score: 1 },
      { createdAt: 'c', updatedAt: 'u', embedding: [1, 0] },
    ),
    await buildStoreItem(
      ctx,
      ['users', 'u1'],
      'b',
      { kind: 'note', score: 9 },
      { createdAt: 'c', updatedAt: 'u', embedding: [0, 1] },
    ),
    await buildStoreItem(
      ctx,
      ['orgs', 'o1'],
      'c',
      { kind: 'doc', score: 5 },
      { createdAt: 'c', updatedAt: 'u' },
    ),
  ];
}

describe('searchItems', () => {
  it('queries the scoped partition and returns only items under the prefix', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: await records(context(client)) });
    const items = await searchItems(context(client), { namespacePrefix: ['users'] });
    expect(items.map((i) => i.key).sort()).toEqual(['a', 'b']);
    expect(
      mock.commandCalls(QueryCommand)[0].args[0].input.ExpressionAttributeValues,
    ).toMatchObject({
      ':pk': 'STORE#users',
    });
  });

  it('applies metadata filters with operators', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: await records(context(client)) });
    const items = await searchItems(context(client), {
      namespacePrefix: ['users'],
      filter: { score: { $gte: 5 } },
    });
    expect(items.map((i) => i.key)).toEqual(['b']);
  });

  it('ranks by semantic similarity to the query when an index is set', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0, 1]) };
    const ctx = context(client, { index: { dims: 2, embeddings: embeddings as never } });
    mock.on(QueryCommand).resolves({ Items: await records(ctx) });
    const items = await searchItems(ctx, { namespacePrefix: ['users'], query: 'find b' });
    expect(items.map((i) => i.key)).toEqual(['b', 'a']);
    expect(items[0].score).toBeGreaterThan(items[1].score ?? 0);
  });

  it('honors offset and limit', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: await records(context(client)) });
    const items = await searchItems(context(client), {
      namespacePrefix: ['users'],
      limit: 1,
      offset: 1,
    });
    expect(items).toHaveLength(1);
  });

  it('ranks an indexed item with no stored embedding last with an undefined score', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0, 1]) };
    const ctx = context(client, { index: { dims: 2, embeddings: embeddings as never } });
    const withVec = await buildStoreItem(
      ctx,
      ['users', 'u1'],
      'b',
      { score: 9 },
      { createdAt: 'c', updatedAt: 'u', embedding: [0, 1] },
    );
    const noVec = await buildStoreItem(
      ctx,
      ['users', 'u1'],
      'x',
      { score: 1 },
      { createdAt: 'c', updatedAt: 'u' },
    );
    mock.on(QueryCommand).resolves({ Items: [withVec, noVec] });
    const items = await searchItems(ctx, { namespacePrefix: ['users'], query: 'q' });
    expect(items.map((i) => i.key)).toEqual(['b', 'x']);
    expect(items[1].score).toBeUndefined();
  });

  it('scans (filtered) and skips foreign rows for an empty prefix', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const storeItem = (await records(ctx)).find((r) => r.SK === 'u1#a');
    mock.on(ScanCommand).resolves({
      Items: [{ PK: 'thread-1', SK: 'META##ckpt-1' }, { PK: 'sess-1', SK: 'SESSION' }, storeItem!],
    });
    const items = await searchItems(ctx, { namespacePrefix: [] });
    expect(items.map((i) => i.key)).toEqual(['a']);
    expect(mock.commandCalls(ScanCommand)[0].args[0].input.FilterExpression).toContain(
      'attribute_exists(#ns)',
    );
  });

  it('ignores a query when no index is configured (unranked matches)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: await records(context(client)) });
    const items = await searchItems(context(client), {
      namespacePrefix: ['users'],
      query: 'anything',
    });
    expect(items.map((i) => i.key).sort()).toEqual(['a', 'b']);
    expect(items.every((i) => i.score === undefined)).toBe(true);
  });

  it('delegates ranking to a vector backend and hydrates the matches', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0, 1]) };
    const recA = await buildStoreItem(
      context(client),
      ['users', 'u1'],
      'a',
      { score: 1 },
      { createdAt: 'c', updatedAt: 'u' },
    );
    const recB = await buildStoreItem(
      context(client),
      ['users', 'u1'],
      'b',
      { score: 9 },
      { createdAt: 'c', updatedAt: 'u' },
    );
    mock.on(GetCommand).callsFake((input) => ({ Item: input.Key.SK === 'u1#b' ? recB : recA }));
    const vectorBackend = {
      upsert: jest.fn(),
      delete: jest.fn(),
      query: jest.fn().mockResolvedValue([
        { namespace: ['users', 'u1'], key: 'b', score: 0.9 },
        { namespace: ['users', 'u1'], key: 'a', score: 0.5 },
      ]),
    };
    const ctx = context(client, {
      index: { dims: 2, embeddings: embeddings as never },
      vectorBackend: vectorBackend as never,
    });
    const items = await searchItems(ctx, { namespacePrefix: ['users'], query: 'q' });
    expect(items.map((i) => i.key)).toEqual(['b', 'a']);
    expect(items.map((i) => i.score)).toEqual([0.9, 0.5]);
    expect(vectorBackend.query).toHaveBeenCalledWith(['users'], [0, 1], 10);
  });

  it('drops backend matches that no longer exist or fail the filter', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0, 1]) };
    mock.on(GetCommand).resolves({});
    const vectorBackend = {
      upsert: jest.fn(),
      delete: jest.fn(),
      query: jest.fn().mockResolvedValue([{ namespace: ['users', 'u1'], key: 'gone', score: 0.9 }]),
    };
    const ctx = context(client, {
      index: { dims: 2, embeddings: embeddings as never },
      vectorBackend: vectorBackend as never,
    });
    const items = await searchItems(ctx, { namespacePrefix: ['users'], query: 'q' });
    expect(items).toEqual([]);
  });

  it('skips a vector backend match outside the requested namespace prefix', async () => {
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
        { namespace: ['other'], key: 'b', score: 0.8 },
      ]),
    };
    const ctx = context(client, {
      index: { dims: 2, embeddings: embeddings as never },
      vectorBackend: vectorBackend as never,
    });
    const items = await searchItems(ctx, { namespacePrefix: ['users'], query: 'q' });
    expect(items.map((i) => i.key)).toEqual(['a']);
    /** getItem must only be called for the in-prefix match, not the skipped one. */
    expect(mock.commandCalls(GetCommand)).toHaveLength(1);
  });

  it('refills from the vector backend when candidates are filtered out, instead of under-returning', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0, 1]) };
    const ctx = context(client, { index: { dims: 2, embeddings: embeddings as never } });
    const recA = await buildStoreItem(
      ctx,
      ['users', 'u1'],
      'a',
      { status: 'active' },
      {
        createdAt: 'c',
        updatedAt: 'u',
      },
    );
    const recB = await buildStoreItem(
      ctx,
      ['users', 'u1'],
      'b',
      { status: 'inactive' },
      {
        createdAt: 'c',
        updatedAt: 'u',
      },
    );
    mock.on(GetCommand).callsFake((input) => ({ Item: input.Key.SK === 'u1#a' ? recA : recB }));
    const vectorBackend = {
      upsert: jest.fn(),
      delete: jest.fn(),
      query: jest
        .fn()
        .mockResolvedValueOnce([{ namespace: ['users', 'u1'], key: 'b', score: 0.9 }])
        .mockResolvedValueOnce([
          { namespace: ['users', 'u1'], key: 'b', score: 0.9 },
          { namespace: ['users', 'u1'], key: 'a', score: 0.5 },
        ]),
    };
    const fullCtx = context(client, {
      index: { dims: 2, embeddings: embeddings as never },
      vectorBackend: vectorBackend as never,
    });
    const items = await searchItems(fullCtx, {
      namespacePrefix: ['users'],
      query: 'q',
      limit: 1,
      filter: { status: 'active' },
    });
    expect(items.map((i) => i.key)).toEqual(['a']);
    expect(vectorBackend.query).toHaveBeenCalledTimes(2);
    const [, , firstTopK] = vectorBackend.query.mock.calls[0];
    const [, , secondTopK] = vectorBackend.query.mock.calls[1];
    expect(secondTopK).toBeGreaterThan(firstTopK);
  });

  it('throws ValidationError instead of silently under-returning when the requested page (offset+limit) exceeds maxSearchCandidates', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0, 1]) };
    mock.on(GetCommand).resolves({});
    const vectorBackend = {
      upsert: jest.fn(),
      delete: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    };
    const ctx = context(client, {
      index: { dims: 2, embeddings: embeddings as never },
      vectorBackend: vectorBackend as never,
      maxSearchCandidates: 5,
    });
    await expect(
      searchItems(ctx, { namespacePrefix: ['users'], query: 'q', offset: 4, limit: 3 }),
    ).rejects.toBeInstanceOf(ValidationError);
    // The guard must fail loud *before* ever querying the backend with a
    // clamped (and therefore wrong) topK — this was the under-return bug.
    expect(vectorBackend.query).not.toHaveBeenCalled();
  });

  it('returns real items when paginating well within maxSearchCandidates (regression: the guard must not affect ordinary pagination)', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = { embedQuery: jest.fn().mockResolvedValue([0, 1]) };
    const recA = await buildStoreItem(
      context(client),
      ['users', 'u1'],
      'a',
      { score: 1 },
      { createdAt: 'c', updatedAt: 'u' },
    );
    const recB = await buildStoreItem(
      context(client),
      ['users', 'u1'],
      'b',
      { score: 9 },
      { createdAt: 'c', updatedAt: 'u' },
    );
    mock.on(GetCommand).callsFake((input) => ({ Item: input.Key.SK === 'u1#b' ? recB : recA }));
    const vectorBackend = {
      upsert: jest.fn(),
      delete: jest.fn(),
      query: jest.fn().mockResolvedValue([
        { namespace: ['users', 'u1'], key: 'b', score: 0.9 },
        { namespace: ['users', 'u1'], key: 'a', score: 0.5 },
      ]),
    };
    // Default maxSearchCandidates from the context() helper is 1000; offset
    // and limit here are both well under it.
    const ctx = context(client, {
      index: { dims: 2, embeddings: embeddings as never },
      vectorBackend: vectorBackend as never,
    });
    const items = await searchItems(ctx, {
      namespacePrefix: ['users'],
      query: 'q',
      offset: 1,
      limit: 1,
    });
    expect(items).toHaveLength(1);
    expect(items[0].key).toBe('a');
  });
});
