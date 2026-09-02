import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ResultTruncatedError, ValidationError } from '../../../../src/shared/errors/errors';
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

describe('searchItems (caps and truncation)', () => {
  it('throws ValidationError on a negative limit', async () => {
    const { client } = createStrictDocumentMock();
    await expect(
      searchItems(context(client), { namespacePrefix: ['users'], limit: -1 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('throws ValidationError on a non-integer offset', async () => {
    const { client } = createStrictDocumentMock();
    await expect(
      searchItems(context(client), { namespacePrefix: ['users'], offset: 2.5 }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('honors a raised maxScanItems for a plain (non-semantic) search over a large namespace', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    // A fixture with MORE than 2 items in the queried partition, so a
    // maxScanItems: 2 cap can only be satisfied if it genuinely reaches
    // paginateQuery/paginateScan inside collectCandidates — with the shared
    // 2-item records() fixture, the cap and result size would coincide
    // regardless of whether the option is actually wired through.
    const threeUsers = [
      await buildStoreItem(
        ctx,
        ['users', 'u1'],
        'a',
        { kind: 'note' },
        { createdAt: 'c', updatedAt: 'u' },
      ),
      await buildStoreItem(
        ctx,
        ['users', 'u1'],
        'b',
        { kind: 'note' },
        { createdAt: 'c', updatedAt: 'u' },
      ),
      await buildStoreItem(
        ctx,
        ['users', 'u1'],
        'c',
        { kind: 'note' },
        { createdAt: 'c', updatedAt: 'u' },
      ),
    ];
    mock.on(QueryCommand).resolves({ Items: threeUsers });

    // With the default cap (10,000) all 3 items would return fine; a small
    // maxScanItems override must actually reach paginateQuery and truncate.
    await expect(
      searchItems(context(client, { maxScanItems: 2 }), { namespacePrefix: ['users'] }),
    ).rejects.toThrow(ResultTruncatedError);

    // Raising the cap high enough lets the same query succeed, proving the
    // override moves in both directions, not just "small value throws."
    const items = await searchItems(context(client, { maxScanItems: 3 }), {
      namespacePrefix: ['users'],
    });
    expect(items.map((i) => i.key).sort()).toEqual(['a', 'b', 'c']);
  });
});
