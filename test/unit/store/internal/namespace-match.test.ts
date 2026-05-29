import {
  matchNamespace,
  prefixRoot,
  truncateDepth,
} from '../../../../src/store/internal/namespace-match';

describe('matchNamespace', () => {
  it('matches a prefix condition, honoring * wildcards', () => {
    expect(matchNamespace(['users', 'u1', 'docs'], { matchType: 'prefix', path: ['users'] })).toBe(
      true,
    );
    expect(
      matchNamespace(['users', 'u1', 'docs'], { matchType: 'prefix', path: ['users', '*'] }),
    ).toBe(true);
    expect(matchNamespace(['users', 'u1'], { matchType: 'prefix', path: ['orgs'] })).toBe(false);
    expect(matchNamespace(['users'], { matchType: 'prefix', path: ['users', 'u1'] })).toBe(false);
  });

  it('matches a suffix condition, honoring * wildcards', () => {
    expect(matchNamespace(['users', 'u1', 'v1'], { matchType: 'suffix', path: ['v1'] })).toBe(true);
    expect(matchNamespace(['users', 'u1', 'v1'], { matchType: 'suffix', path: ['*', 'v1'] })).toBe(
      true,
    );
    expect(matchNamespace(['users', 'u1', 'v2'], { matchType: 'suffix', path: ['v1'] })).toBe(
      false,
    );
  });
});

describe('truncateDepth', () => {
  it('caps a namespace to maxDepth elements', () => {
    expect(truncateDepth(['a', 'b', 'c'], 2)).toEqual(['a', 'b']);
    expect(truncateDepth(['a', 'b'], 5)).toEqual(['a', 'b']);
    expect(truncateDepth(['a', 'b'], undefined)).toEqual(['a', 'b']);
  });
});

describe('prefixRoot', () => {
  it('returns the leading concrete elements of the first prefix condition', () => {
    expect(prefixRoot([{ matchType: 'prefix', path: ['users', 'u1'] }])).toEqual(['users', 'u1']);
  });

  it('stops at the first wildcard', () => {
    expect(prefixRoot([{ matchType: 'prefix', path: ['users', '*', 'docs'] }])).toEqual(['users']);
  });

  it('returns an empty array when there is no prefix condition', () => {
    expect(prefixRoot([{ matchType: 'suffix', path: ['v1'] }])).toEqual([]);
    expect(prefixRoot(undefined)).toEqual([]);
  });

  it('returns an empty array when the prefix starts with a wildcard', () => {
    expect(prefixRoot([{ matchType: 'prefix', path: ['*', 'u1'] }])).toEqual([]);
  });
});
