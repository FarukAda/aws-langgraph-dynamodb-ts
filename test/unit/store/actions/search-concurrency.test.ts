import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { searchItems } from '../../../../src/store/actions/search';
import { buildStoreItem } from '../../../../src/store/internal/item-mapper';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { overlapOffloader } from '../../../shared/helpers/offload-overlap';

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

describe('searchItems offloaded reads (CODEC-14)', () => {
  it('decodes offloaded candidates up to 8 at a time and keeps every match', async () => {
    const { client, mock } = createStrictDocumentMock();
    const { offloader, maxInFlight } = overlapOffloader();
    const ctx = context(client, { offloader: offloader as never });
    const records = [];
    for (let i = 0; i < 6; i++) {
      records.push(
        await buildStoreItem(
          ctx,
          ['users', 'u1'],
          `k${i}`,
          { i },
          { createdAt: 'c', updatedAt: 'u' },
        ),
      );
    }
    mock.on(QueryCommand).resolves({ Items: records });
    const items = await searchItems(ctx, { namespacePrefix: ['users'], filter: { i: 3 } });
    expect(items.map((item) => item.key)).toEqual(['k3']);
    expect(maxInFlight()).toBeGreaterThan(1);
    expect(maxInFlight()).toBeLessThanOrEqual(8);
  });
});
