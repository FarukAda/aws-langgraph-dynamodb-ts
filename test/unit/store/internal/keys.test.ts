import { namespaceMatchesPrefix, namespaceToPartition } from '../../../../src/store/internal/keys';

describe('store keys', () => {
  it('joins a namespace into a partition key', () => {
    expect(namespaceToPartition(['users', 'u1'])).toBe('users#u1');
    expect(namespaceToPartition([])).toBe('');
  });

  it('matches a namespace against an array prefix (not a string prefix)', () => {
    expect(namespaceMatchesPrefix(['users', 'u1'], ['users'])).toBe(true);
    expect(namespaceMatchesPrefix(['users', 'u1'], ['users', 'u1'])).toBe(true);
    expect(namespaceMatchesPrefix(['users', 'u1'], [])).toBe(true);
    expect(namespaceMatchesPrefix(['userspace'], ['users'])).toBe(false);
    expect(namespaceMatchesPrefix(['users'], ['users', 'u1'])).toBe(false);
  });
});
