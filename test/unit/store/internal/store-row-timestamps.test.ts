import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import type { DocItem } from '../../../../src/shared/dynamodb/client';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { searchItems } from '../../../../src/store/actions/search';
import { getItem } from '../../../../src/store/internal/get-item';
import {
  buildStoreItem,
  narrowStoreRecord,
  narrowWholeRecord,
} from '../../../../src/store/internal/item-mapper';
import { parseStoreAddress } from '../../../../src/store/internal/parse';
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

const AT = '2026-01-01T00:00:00.000Z';

/** A store row as this package writes it, minus the attributes `missing` names. */
async function rowWithout(ctx: StoreContext, key: string, ...missing: string[]): Promise<DocItem> {
  const record = await buildStoreItem(
    ctx,
    ['users', 'u1'],
    key,
    { kind: 'note' },
    { createdAt: AT, updatedAt: AT },
  );
  const row: DocItem = {};
  for (const [name, value] of Object.entries(record)) {
    if (!missing.includes(name)) row[name] = value;
  }
  return row;
}

/**
 * `readStoreItem` builds `new Date(record.createdAt)`, and a row written without
 * the attribute makes that `new Date(undefined)` — an `Invalid Date` handed
 * back under a declared `Date`, which throws only later, in the caller's own
 * `toISOString`. The row is narrowed away instead, where every other row this
 * adapter cannot speak for already is.
 */
describe('narrowWholeRecord (L-05b)', () => {
  it('narrows a row carrying both timestamps', async () => {
    const record = await rowWithout(context({} as never), 'good');

    expect(narrowWholeRecord(record)).toBeDefined();
  });

  it.each([['createdAt'], ['updatedAt'], ['createdAt', 'updatedAt']])(
    'refuses a row missing %s',
    async (...missing: string[]) => {
      const record = await rowWithout(context({} as never), 'bad', ...missing);

      expect(narrowWholeRecord(record)).toBeUndefined();
    },
  );

  it('refuses a timestamp that is present but not a string', async () => {
    const record = await rowWithout(context({} as never), 'bad');

    expect(narrowWholeRecord({ ...record, updatedAt: 1_700_000_000 })).toBeUndefined();
  });

  /**
   * The identity narrow stays weaker on purpose: a namespace listing projects
   * rows onto `PK`, `SK`, `namespace`, `key` and `v` and never reads a
   * timestamp, so requiring one there would hide every namespace in the table.
   */
  it('leaves the identity narrow able to accept a projected row', () => {
    const projected = {
      PK: 'STORE#users',
      SK: 'u1#profile',
      namespace: ['users', 'u1'],
      key: 'profile',
    };

    expect(narrowStoreRecord(projected)).toBeDefined();
    expect(narrowWholeRecord(projected)).toBeUndefined();
  });
});

describe('a store listing over a mix of good and bad rows (L-05b)', () => {
  it('returns the items whose rows carry timestamps and skips the one that does not', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    mock.on(QueryCommand).resolves({
      Items: [
        await rowWithout(ctx, 'first'),
        await rowWithout(ctx, 'rotten', 'createdAt', 'updatedAt'),
        await rowWithout(ctx, 'second'),
      ],
    });

    const items = await searchItems(ctx, parsedSearch({ namespacePrefix: ['users'] }));

    expect(items.map((item) => item.key)).toEqual(['first', 'second']);
  });

  /**
   * `getItem` already answers "absent", "expired" and "not this adapter's row"
   * with one `null`, because a caller cannot act on the difference. A row whose
   * timestamps this adapter never wrote is the same answer.
   */
  it('answers a single read of such a row with null rather than an Invalid Date', async () => {
    const { client, mock } = createStrictDocumentMock();
    const ctx = context(client);
    mock.on(GetCommand).resolves({ Item: await rowWithout(ctx, 'rotten', 'createdAt') });

    await expect(getItem(ctx, parseStoreAddress(['users', 'u1'], 'rotten'))).resolves.toBeNull();
  });
});
