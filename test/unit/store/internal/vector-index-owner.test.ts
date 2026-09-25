import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import {
  parseNamespace,
  parsePutArguments,
  parseStoreAddress,
} from '../../../../src/store/internal/parse';
import type { StoreContext } from '../../../../src/store/internal/setup';
import {
  dropVectorWhenGone,
  hasVectorBackend,
  itemVector,
  reconcileVectors,
  syncItemVector,
} from '../../../../src/store/internal/vector-index';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const backend = () => ({
  upsert: jest.fn().mockResolvedValue(undefined),
  query: jest.fn().mockResolvedValue([]),
  delete: jest.fn().mockResolvedValue(undefined),
});
const index = {
  dims: 2,
  fields: ['text'],
  embeddings: {
    embedQuery: jest.fn(),
    embedDocuments: jest.fn((texts: string[]) => Promise.resolve(texts.map(() => [1, 0]))),
  },
};

describe('hasVectorBackend', () => {
  it('answers only for a store with both an index and a backend', () => {
    expect(hasVectorBackend({} as StoreContext)).toBe(false);
    expect(hasVectorBackend({ index } as never)).toBe(false);
    expect(hasVectorBackend({ index, vectorBackend: backend() } as never)).toBe(true);
  });
});

describe('itemVector', () => {
  const put = parsePutArguments(['n'], 'k', { text: 'hello' }, undefined);

  it('embeds nothing without a backend, or for a put that indexes nothing', async () => {
    await expect(itemVector({ index } as never, put)).resolves.toBeUndefined();
    const unindexed = parsePutArguments(['n'], 'k', { text: 'hello' }, false);
    await expect(
      itemVector({ index, vectorBackend: backend() } as never, unindexed),
    ).resolves.toBeUndefined();
  });

  it("embeds a put's configured fields when the store keeps a vector copy", async () => {
    await expect(itemVector({ index, vectorBackend: backend() } as never, put)).resolves.toEqual([
      1, 0,
    ]);
  });
});

describe('syncItemVector', () => {
  const address = parseStoreAddress(['n'], 'k');

  it('does nothing without a backend', async () => {
    await expect(syncItemVector({} as StoreContext, address, [1, 0])).resolves.toBeUndefined();
  });

  it('upserts a vector, and deletes the entry when there is none', async () => {
    const copy = backend();
    const context = { vectorBackend: copy, logger: SILENT_LOGGER } as never;
    await syncItemVector(context, address, [1, 0]);
    await syncItemVector(context, address, undefined);
    expect(copy.upsert).toHaveBeenCalledWith(['n'], 'k', [1, 0]);
    expect(copy.delete).toHaveBeenCalledWith(['n'], 'k');
  });
});

describe('dropVectorWhenGone', () => {
  it("drops the entry once a fresh read finds the item's row gone", async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    const copy = backend();
    const context = { client, tableName: 't', vectorBackend: copy, logger: SILENT_LOGGER };
    await dropVectorWhenGone(context as never, parseStoreAddress(['n'], 'k'));
    expect(copy.delete).toHaveBeenCalledWith(['n'], 'k');
  });
});

describe('reconcileVectors', () => {
  it('reports nothing to do for an empty prefix and a backend that cannot list', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    const context = {
      client,
      tableName: 't',
      logger: SILENT_LOGGER,
      maxScanItems: 100,
      index,
      vectorBackend: backend(),
    };
    await expect(reconcileVectors(context as never, parseNamespace(['n']))).resolves.toEqual({
      upserted: 0,
      pruned: 0,
    });
  });
});
