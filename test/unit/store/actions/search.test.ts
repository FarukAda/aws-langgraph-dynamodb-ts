import { ScanCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { searchItems } from '../../../../src/store/actions/search';
import { buildStoreItem } from '../../../../src/store/internal/item-mapper';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

function context(client: StoreContext['client'], extra?: Partial<StoreContext>): StoreContext {
  return { client, tableName: 'store', serde: JSON_SERDE, logger: SILENT_LOGGER, ...extra };
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
  it('returns only items under the namespace prefix', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: await records(context(client)) });
    const items = await searchItems(context(client), { namespacePrefix: ['users'] });
    expect(items.map((i) => i.key).sort()).toEqual(['a', 'b']);
  });

  it('applies metadata filters with operators', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: await records(context(client)) });
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
    mock.on(ScanCommand).resolves({ Items: await records(ctx) });
    const items = await searchItems(ctx, { namespacePrefix: ['users'], query: 'find b' });
    expect(items.map((i) => i.key)).toEqual(['b', 'a']);
    expect(items[0].score).toBeGreaterThan(items[1].score ?? 0);
  });

  it('honors offset and limit', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: await records(context(client)) });
    const items = await searchItems(context(client), {
      namespacePrefix: ['users'],
      limit: 1,
      offset: 1,
    });
    expect(items).toHaveLength(1);
  });

  it('ignores a query when no index is configured (unranked matches)', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: await records(context(client)) });
    const items = await searchItems(context(client), {
      namespacePrefix: ['users'],
      query: 'anything',
    });
    expect(items.map((i) => i.key).sort()).toEqual(['a', 'b']);
    expect(items.every((i) => i.score === undefined)).toBe(true);
  });
});
