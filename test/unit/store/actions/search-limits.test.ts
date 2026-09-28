import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
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

/**
 * A negative limit and a non-integer offset are refused by the parser before
 * `searchItems` ever runs (see `parseSearch` in `test/unit/store/internal/parse.test.ts`);
 * this action no longer checks its input's shape.
 */
describe('searchItems (caps and truncation)', () => {
  it('honors a raised maxScanItems for a plain (non-semantic) search over a large namespace', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    // A fixture with MORE than 2 items in the queried partition, so a
    // maxScanItems: 2 cap can only be satisfied if it genuinely reaches
    // paginateQuery/paginateScan inside collectCandidates — with the shared
    // 2-item records() fixture, the cap and result size would coincide
    // regardless of whether the option is actually wired through.
    const threeUsers = [
      await buildStoreRow(
        ctx,
        { namespace: ['users', 'u1'], key: 'a' },
        { kind: 'note' },
        { createdAt: 'c', updatedAt: 'u' },
      ),
      await buildStoreRow(
        ctx,
        { namespace: ['users', 'u1'], key: 'b' },
        { kind: 'note' },
        { createdAt: 'c', updatedAt: 'u' },
      ),
      await buildStoreRow(
        ctx,
        { namespace: ['users', 'u1'], key: 'c' },
        { kind: 'note' },
        { createdAt: 'c', updatedAt: 'u' },
      ),
    ];
    mock.on(QueryCommand).resolves({ Items: threeUsers });

    // With the default cap (10,000) all 3 items would return fine; a small
    // maxScanItems override must actually reach paginateQuery and truncate.
    await expect(
      searchItems(
        context(client, { maxScanItems: 2 }),
        parsedSearch({ namespacePrefix: ['users'] }),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.RESULT_TRUNCATED });

    // Raising the cap high enough lets the same query succeed, proving the
    // override moves in both directions, not just "small value throws."
    const items = await searchItems(
      context(client, { maxScanItems: 3 }),
      parsedSearch({
        namespacePrefix: ['users'],
      }),
    );
    expect(items.map((i) => i.key).sort()).toEqual(['a', 'b', 'c']);
  });
});
