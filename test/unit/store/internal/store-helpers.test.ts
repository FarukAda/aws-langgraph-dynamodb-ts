import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { passesFilter } from '../../../../src/store/internal/filter';
import { parseListOperation } from '../../../../src/store/internal/parse';
import {
  existingFrom,
  isLiveRow,
  projectKeys,
  readExisting,
  scopedQuery,
} from '../../../../src/store/internal/rows';
import {
  assertStoreOptions,
  MAX_SCAN_ITEMS,
  MAX_SEARCH_CANDIDATES,
} from '../../../../src/store/internal/setup';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { FROZEN_NOW_MS } from '../../../shared/helpers/test-setup';

function context(client: StoreContext['client']): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    maxIterations: 1000,
    vectorScoreDirection: 'relevance',
  };
}

describe('projectKeys', () => {
  it('projects a row s identity and version and keeps the input s own attribute names', () => {
    const projected = projectKeys(scopedQuery('store', ['users', 'u1']));
    expect(projected.ProjectionExpression).toBe('PK, SK, #ns, #key, #v');
    expect(projected.ExpressionAttributeNames).toMatchObject({
      '#pk': 'PK',
      '#sk': 'SK',
      '#ns': 'namespace',
      '#key': 'key',
      '#v': 'v',
    });
  });

  it('leaves the key condition and its values untouched', () => {
    const query = scopedQuery('store', ['users', 'u1']);
    const projected = projectKeys(query);
    expect(projected.KeyConditionExpression).toBe(query.KeyConditionExpression);
    expect(projected.ExpressionAttributeValues).toEqual(query.ExpressionAttributeValues);
  });
});

describe('existingFrom', () => {
  it('reports what the row a put supersedes holds', () => {
    expect(
      existingFrom({ createdAt: 'c', rev: 'r1', ttl: 1, value: { location: 'INLINE' } }),
    ).toEqual({
      exists: true,
      createdAt: 'c',
      ttl: 1,
      revision: 'r1',
      value: { location: 'INLINE' },
    });
  });

  it('reports no row at all for an absent read', () => {
    expect(existingFrom(undefined)).toEqual({
      exists: false,
      createdAt: undefined,
      ttl: undefined,
      revision: undefined,
      value: undefined,
    });
  });

  /** A row written before revisions existed reports none, which the swap tests for. */
  it('reports a row that carries no revision as existing without one', () => {
    expect(existingFrom({ createdAt: 'c' })).toMatchObject({
      exists: true,
      revision: undefined,
    });
  });
});

describe('readExisting', () => {
  /** A consistent, projected read: what a put inherits, pins on and releases, and nothing more. */
  it('reads the fields a put needs, strongly consistently, and projects them onto ExistingRowMeta', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({
      Item: { createdAt: 'c', rev: 'r1', ttl: 7, value: { location: 'S3', s3Key: 'k' } },
    });
    const existing = await readExisting(context(client), { PK: 'STORE#ns', SK: 'k' });
    expect(existing).toEqual({
      exists: true,
      createdAt: 'c',
      ttl: 7,
      revision: 'r1',
      value: { location: 'S3', s3Key: 'k' },
    });
    const input = mock.commandCalls(GetCommand)[0].args[0].input;
    expect(input).toMatchObject({
      TableName: 'store',
      Key: { PK: 'STORE#ns', SK: 'k' },
      ConsistentRead: true,
      ProjectionExpression: '#c, #r, #ttl, #v.#loc, #v.#s3k',
    });
  });

  it('reports no row for an absent one', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    await expect(readExisting(context(client), { PK: 'STORE#ns', SK: 'k' })).resolves.toEqual(
      existingFrom(undefined),
    );
  });
});

describe('isLiveRow', () => {
  const nowSeconds = FROZEN_NOW_MS / 1000;

  it('is false for no row', () => {
    expect(isLiveRow(existingFrom(undefined))).toBe(false);
  });

  it('is true for a row with no expiry, or one still ahead', () => {
    expect(isLiveRow(existingFrom({ createdAt: 'c' }))).toBe(true);
    expect(isLiveRow(existingFrom({ createdAt: 'c', ttl: nowSeconds + 1 }))).toBe(true);
  });

  /** The expiry instant itself counts as expired, as every reader's filter has it. */
  it('is false for a row at or past its expiry, however recently', () => {
    expect(isLiveRow(existingFrom({ createdAt: 'c', ttl: nowSeconds }))).toBe(false);
    expect(isLiveRow(existingFrom({ createdAt: 'c', ttl: nowSeconds - 86_400 }))).toBe(false);
  });
});

describe('passesFilter', () => {
  const item = { namespace: ['users'], key: 'u1', value: { score: 5 } } as never;

  it('passes every item when the search names no filter', () => {
    expect(passesFilter(item, undefined)).toBe(true);
  });

  it('passes an item that satisfies every clause and fails one that does not', () => {
    expect(passesFilter(item, { score: 5 })).toBe(true);
    expect(passesFilter(item, { score: 6 })).toBe(false);
    expect(passesFilter(item, { score: { $gt: 4 } })).toBe(true);
  });

  /** An empty filter constrains nothing, as the reference store answers it. */
  it('passes every item for an empty filter object', () => {
    expect(passesFilter(item, {})).toBe(true);
  });

  /** One row whose value is not an object must not fail a search over many. */
  it('fails, rather than throws, for a value that is not an object', () => {
    const odd = { namespace: ['users'], key: 'u2', value: null } as never;
    expect(passesFilter(odd, { score: 5 })).toBe(false);
  });
});

describe('parseListOperation maxDepth', () => {
  const listing = (maxDepth?: number) => parseListOperation({ offset: 0, limit: 0, maxDepth });

  it('accepts an absent depth and any positive integer', () => {
    expect(() => listing(undefined)).not.toThrow();
    expect(() => listing(1)).not.toThrow();
    expect(() => listing(10)).not.toThrow();
  });

  /** A negative depth silently inverted truncation through `slice(0, -n)`. */
  it('refuses a depth that would truncate from the wrong end or to nothing', () => {
    for (const depth of [0, -1, 1.5, Number.NaN]) {
      try {
        listing(depth);
        throw new Error(`should have thrown for ${depth}`);
      } catch (error) {
        expect((error as { code: ErrorCode }).code).toBe(ErrorCode.VALIDATION);
        expect((error as { context: { field?: string } }).context.field).toBe('maxDepth');
      }
    }
  });
});

describe('assertStoreOptions', () => {
  const embeddings = { embedQuery: () => [], embedDocuments: () => [] } as never;

  it('accepts a minimal store and one with a complete index', () => {
    expect(() => assertStoreOptions({ tableName: 'store' })).not.toThrow();
    expect(() =>
      assertStoreOptions({ tableName: 'store', index: { dims: 2, embeddings } }),
    ).not.toThrow();
  });

  /** Without embeddings every put would clear the vector and every query rank nothing. */
  it('refuses a vectorBackend without an index', () => {
    try {
      assertStoreOptions({ tableName: 'store', vectorBackend: {} as never });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { context: { field?: string } }).context.field).toBe('vectorBackend');
    }
  });

  it('refuses an index whose embeddings cannot embed', () => {
    expect(() =>
      assertStoreOptions({ tableName: 'store', index: { dims: 2, embeddings: {} as never } }),
    ).toThrow(/embedQuery/);
    expect(() =>
      assertStoreOptions({
        tableName: 'store',
        index: { dims: 2, embeddings: { embedQuery: () => [] } as never },
      }),
    ).toThrow(/embedDocuments/);
  });

  it('refuses a score direction outside its union, which would rank a backend backwards', () => {
    expect(() =>
      assertStoreOptions({
        tableName: 'store',
        vectorScoreDirection: 'Distance' as never,
        index: { dims: 2, embeddings },
        vectorBackend: {} as never,
      }),
    ).toThrow(/vectorScoreDirection/);
  });

  it('refuses a non-positive in-memory cap, which would return nothing', () => {
    expect(() => assertStoreOptions({ tableName: 'store', maxScanItems: 0 })).toThrow(
      /maxScanItems/,
    );
    expect(() => assertStoreOptions({ tableName: 'store', maxSearchCandidates: 0 })).toThrow(
      /maxSearchCandidates/,
    );
  });

  /**
   * Both caps hold decoded rows in memory; unbounded, a typo or hostile value
   * exhausts it. Rejected one above the named ceiling, accepted at it.
   */
  it('refuses an in-memory cap above its named ceiling, accepts it at the ceiling', () => {
    expect(() =>
      assertStoreOptions({ tableName: 'store', maxScanItems: MAX_SCAN_ITEMS + 1 }),
    ).toThrow(/maxScanItems/);
    expect(() =>
      assertStoreOptions({ tableName: 'store', maxScanItems: MAX_SCAN_ITEMS }),
    ).not.toThrow();

    expect(() =>
      assertStoreOptions({ tableName: 'store', maxSearchCandidates: MAX_SEARCH_CANDIDATES + 1 }),
    ).toThrow(/maxSearchCandidates/);
    expect(() =>
      assertStoreOptions({ tableName: 'store', maxSearchCandidates: MAX_SEARCH_CANDIDATES }),
    ).not.toThrow();
  });
});
