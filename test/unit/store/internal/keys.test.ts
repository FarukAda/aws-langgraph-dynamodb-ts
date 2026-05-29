import {
  NAMESPACE_SEPARATOR,
  namespaceMatchesPrefix,
  partitionKey,
  sortKey,
  sortKeyPrefix,
} from '../../../../src/store/internal/keys';

describe('store keys', () => {
  it('uses namespace[0] as the partition key', () => {
    expect(partitionKey(['users', 'u1', 'docs'])).toBe('users');
  });

  it('builds the sort key from the rest of the namespace + key', () => {
    expect(sortKey(['users', 'u1', 'docs'], 'k1')).toBe('u1#docs#k1');
    expect(sortKey(['users'], 'k1')).toBe('k1');
  });

  it('builds a begins_with prefix for a scoped search (delimiter-terminated)', () => {
    expect(sortKeyPrefix(['users', 'u1'])).toBe('u1#');
    expect(sortKeyPrefix(['users'])).toBe('');
  });

  it('matches namespaces by array prefix, not string prefix', () => {
    expect(namespaceMatchesPrefix(['users', 'u1'], ['users'])).toBe(true);
    expect(namespaceMatchesPrefix(['users', 'u1'], ['users', 'u1'])).toBe(true);
    expect(namespaceMatchesPrefix(['userspace'], ['users'])).toBe(false);
    expect(namespaceMatchesPrefix(['users'], ['users', 'u1'])).toBe(false);
  });

  it('exposes the separator', () => {
    expect(NAMESPACE_SEPARATOR).toBe('#');
  });
});
