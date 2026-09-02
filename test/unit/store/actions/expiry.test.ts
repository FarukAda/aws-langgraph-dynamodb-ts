import { GetCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { getItem } from '../../../../src/store/actions/get';
import { listNamespaces } from '../../../../src/store/actions/list-namespaces';
import { reconcileVectorIndex } from '../../../../src/store/actions/reconcile-vector-index';
import { searchItems } from '../../../../src/store/actions/search';
import { buildStoreItem } from '../../../../src/store/internal/item-mapper';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { FROZEN_NOW_MS } from '../../../shared/helpers/test-setup';

const NOW = Math.floor(FROZEN_NOW_MS / 1000);

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

async function rows(ctx: StoreContext) {
  const live = await buildStoreItem(
    ctx,
    ['users', 'u1'],
    'live',
    { text: 'live' },
    {
      createdAt: 'c',
      updatedAt: 'u',
      ttlTimestamp: NOW + 60,
    },
  );
  const expired = await buildStoreItem(
    ctx,
    ['users', 'u2'],
    'gone',
    { text: 'gone' },
    {
      createdAt: 'c',
      updatedAt: 'u',
      ttlTimestamp: NOW - 60,
    },
  );
  return { live, expired };
}

describe('expired rows are filtered on every store read path (STORE-04)', () => {
  it('get returns null for a row past its ttl', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const { expired } = await rows(ctx);
    mock.on(GetCommand).resolves({ Item: expired });
    await expect(getItem(ctx, ['users', 'u2'], 'gone')).resolves.toBeNull();
  });

  it('search drops an expired candidate and asks DynamoDB to filter them too', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const { live, expired } = await rows(ctx);
    mock.on(QueryCommand).resolves({ Items: [live, expired] });
    const items = await searchItems(ctx, { namespacePrefix: ['users'] });
    expect(items.map((item) => item.key)).toEqual(['live']);
    expect(mock.commandCalls(QueryCommand)[0].args[0].input.FilterExpression).toContain('#ttl');
  });

  it('listNamespaces omits a namespace whose only row is expired, keeping the item filter', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const { live, expired } = await rows(ctx);
    mock.on(ScanCommand).resolves({ Items: [expired, live] });
    await expect(listNamespaces(ctx, { limit: 10, offset: 0 })).resolves.toEqual([['users', 'u1']]);
    const filter = mock.commandCalls(ScanCommand)[0].args[0].input.FilterExpression ?? '';
    expect(filter).toContain('attribute_exists(#ns)');
    expect(filter).toContain('#ttl');
  });

  it('reconcileVectorIndex neither re-pushes nor counts an expired item as live', async () => {
    const { client, mock } = createStrictDocumentMock();
    const embeddings = {
      embedQuery: jest.fn(),
      embedDocuments: jest.fn(async (texts: string[]) => texts.map(() => [0.5])),
    };
    const backend = {
      upsert: jest.fn().mockResolvedValue(undefined),
      delete: jest.fn(),
      query: jest.fn(),
    };
    const ctx = context(client, {
      index: { dims: 1, embeddings: embeddings as never },
      vectorBackend: backend,
    });
    const { live, expired } = await rows(ctx);
    mock.on(QueryCommand).resolves({ Items: [live, expired] });
    await expect(reconcileVectorIndex(ctx, ['users'])).resolves.toEqual({ upserted: 1, pruned: 0 });
    expect(backend.upsert).toHaveBeenCalledWith(['users', 'u1'], 'live', [0.5]);
  });
});
