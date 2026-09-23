import { MAX_SCAN_ITEMS, MAX_SEARCH_CANDIDATES } from '../../../../src/shared/constants';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { validateStoreOptions } from '../../../../src/store/internal/option-validation';
import { projectKeys, scopedQuery } from '../../../../src/store/internal/query';
import { existingFrom } from '../../../../src/store/internal/read-existing';
import { passesFilter } from '../../../../src/store/internal/search-filter';
import { validateMaxDepth } from '../../../../src/store/internal/validation';

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
    expect(existingFrom({ createdAt: 'c', rev: 'r1', value: { location: 'INLINE' } })).toEqual({
      exists: true,
      createdAt: 'c',
      revision: 'r1',
      value: { location: 'INLINE' },
    });
  });

  it('reports no row at all for an absent read', () => {
    expect(existingFrom(undefined)).toEqual({
      exists: false,
      createdAt: undefined,
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

describe('passesFilter', () => {
  const item = { namespace: ['users'], key: 'u1', value: { score: 5 } } as never;

  it('passes every item when the search names no filter', () => {
    expect(passesFilter(item, { namespacePrefix: ['users'] })).toBe(true);
  });

  it('passes an item that satisfies every clause and fails one that does not', () => {
    expect(passesFilter(item, { namespacePrefix: ['users'], filter: { score: 5 } })).toBe(true);
    expect(passesFilter(item, { namespacePrefix: ['users'], filter: { score: 6 } })).toBe(false);
    expect(passesFilter(item, { namespacePrefix: ['users'], filter: { score: { $gt: 4 } } })).toBe(
      true,
    );
  });

  /** An empty filter constrains nothing, as the reference store answers it. */
  it('passes every item for an empty filter object', () => {
    expect(passesFilter(item, { namespacePrefix: ['users'], filter: {} })).toBe(true);
  });

  /** One row whose value is not an object must not fail a search over many. */
  it('fails, rather than throws, for a value that is not an object', () => {
    const odd = { namespace: ['users'], key: 'u2', value: null } as never;
    expect(passesFilter(odd, { namespacePrefix: ['users'], filter: { score: 5 } })).toBe(false);
  });
});

describe('validateMaxDepth', () => {
  it('accepts an absent depth and any positive integer', () => {
    expect(() => validateMaxDepth(undefined)).not.toThrow();
    expect(() => validateMaxDepth(1)).not.toThrow();
    expect(() => validateMaxDepth(10)).not.toThrow();
  });

  /** A negative depth silently inverted truncation through `slice(0, -n)`. */
  it('refuses a depth that would truncate from the wrong end or to nothing', () => {
    for (const depth of [0, -1, 1.5, Number.NaN]) {
      try {
        validateMaxDepth(depth);
        throw new Error(`should have thrown for ${depth}`);
      } catch (error) {
        expect((error as { code: ErrorCode }).code).toBe(ErrorCode.VALIDATION);
        expect((error as { context: { field?: string } }).context.field).toBe('maxDepth');
      }
    }
  });
});

describe('validateStoreOptions', () => {
  const embeddings = { embedQuery: () => [], embedDocuments: () => [] } as never;

  it('accepts a minimal store and one with a complete index', () => {
    expect(() => validateStoreOptions({ tableName: 'store' })).not.toThrow();
    expect(() =>
      validateStoreOptions({ tableName: 'store', index: { dims: 2, embeddings } }),
    ).not.toThrow();
  });

  /** Without embeddings every put would clear the vector and every query rank nothing. */
  it('refuses a vectorBackend without an index', () => {
    try {
      validateStoreOptions({ tableName: 'store', vectorBackend: {} as never });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { context: { field?: string } }).context.field).toBe('vectorBackend');
    }
  });

  it('refuses an index whose embeddings cannot embed', () => {
    expect(() =>
      validateStoreOptions({ tableName: 'store', index: { dims: 2, embeddings: {} as never } }),
    ).toThrow(/embedQuery/);
    expect(() =>
      validateStoreOptions({
        tableName: 'store',
        index: { dims: 2, embeddings: { embedQuery: () => [] } as never },
      }),
    ).toThrow(/embedDocuments/);
  });

  it('refuses a score direction outside its union, which would rank a backend backwards', () => {
    expect(() =>
      validateStoreOptions({
        tableName: 'store',
        vectorScoreDirection: 'Distance' as never,
        index: { dims: 2, embeddings },
        vectorBackend: {} as never,
      }),
    ).toThrow(/vectorScoreDirection/);
  });

  it('refuses a non-positive in-memory cap, which would return nothing', () => {
    expect(() => validateStoreOptions({ tableName: 'store', maxScanItems: 0 })).toThrow(
      /maxScanItems/,
    );
    expect(() => validateStoreOptions({ tableName: 'store', maxSearchCandidates: 0 })).toThrow(
      /maxSearchCandidates/,
    );
  });

  /**
   * Both caps hold decoded rows in memory; unbounded, a typo or hostile value
   * exhausts it. Rejected one above the named ceiling, accepted at it.
   */
  it('refuses an in-memory cap above its named ceiling, accepts it at the ceiling', () => {
    expect(() =>
      validateStoreOptions({ tableName: 'store', maxScanItems: MAX_SCAN_ITEMS + 1 }),
    ).toThrow(/maxScanItems/);
    expect(() =>
      validateStoreOptions({ tableName: 'store', maxScanItems: MAX_SCAN_ITEMS }),
    ).not.toThrow();

    expect(() =>
      validateStoreOptions({ tableName: 'store', maxSearchCandidates: MAX_SEARCH_CANDIDATES + 1 }),
    ).toThrow(/maxSearchCandidates/);
    expect(() =>
      validateStoreOptions({ tableName: 'store', maxSearchCandidates: MAX_SEARCH_CANDIDATES }),
    ).not.toThrow();
  });
});
