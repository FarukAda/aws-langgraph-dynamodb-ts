import { QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { searchItems } from '../../../../src/store/actions/search';
import { buildStoreRow, type StoreItemRow } from '../../../../src/store/internal/rows';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { parsedSearch } from '../../../shared/helpers/parsed-inputs';

function context(client: StoreContext['client']): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    vectorScoreDirection: 'relevance',
  };
}

/** One healthy item of this release's, built the way a put builds it. */
async function item(ctx: StoreContext, key: string): Promise<StoreItemRow> {
  return buildStoreRow(
    ctx,
    { namespace: ['users', 'u1'], key },
    { kind: 'note' },
    {
      createdAt: 'c',
      updatedAt: 'u',
    },
  );
}

/** Answer the read whichever command the prefix made the search send. */
function serve(
  mock: ReturnType<typeof createStrictDocumentMock>['mock'],
  items: Record<string, unknown>[],
) {
  mock.on(ScanCommand).resolves({ Items: items });
  mock.on(QueryCommand).resolves({ Items: items });
}

/**
 * A search walks rows it never named, so what it does with a row a newer
 * release wrote decides whether a page can come back silently short. The
 * narrow it shares with `get` reports such a row, and the public `Throws:` on
 * `DynamoDBStore.search` says so; these pin the two halves of that.
 */
describe.each([
  ['a query, under a prefix', ['users']],
  ['a scan, over every namespace', []],
])('search through %s', (_path, namespacePrefix: string[]) => {
  it('reports a row a newer release wrote rather than paging over it', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    serve(mock, [{ ...(await item(ctx, 'k0')), v: 2 }]);

    await expect(
      searchItems(ctx, parsedSearch({ namespacePrefix, limit: 10 })),
    ).rejects.toMatchObject({
      code: ErrorCode.FORMAT_UNSUPPORTED,
      context: { field: 'v' },
    });
  });

  /**
   * At a version this release reads, a row it cannot narrow is still dropped
   * silently: this read walks a whole prefix or table, and one hand-written
   * row must not cost a caller the items beside it.
   */
  it('still skips a foreign row at a version it reads', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    const foreign = { PK: 'STORE#users', SK: 'u1#other', namespace: 'not-an-array', v: 1 };
    serve(mock, [foreign, { ...(await item(ctx, 'k0')) }]);

    const items = await searchItems(ctx, parsedSearch({ namespacePrefix, limit: 10 }));

    expect(items.map((found) => found.key)).toEqual(['k0']);
  });
});
