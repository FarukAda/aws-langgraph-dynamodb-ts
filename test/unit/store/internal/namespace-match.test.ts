import { matchNamespace, truncateDepth } from '../../../../src/store/internal/namespace-match';

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
