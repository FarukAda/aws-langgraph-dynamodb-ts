import { KEY_SEPARATOR } from '../../../../src/shared/dynamodb/table-schema';
import {
  itemRowKey,
  namespaceMatchesPrefix,
  partitionKey,
  sortKey,
  sortKeyPrefix,
  storePartitionPrefix,
} from '../../../../src/store/internal/rows';

describe('store keys', () => {
  it('uses namespace[0] as the partition key', () => {
    expect(partitionKey(['users', 'u1', 'docs'])).toBe('STORE#users');
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
    expect(KEY_SEPARATOR).toBe('#');
  });

  it('exposes the partition tag the rootless scan restricts on', () => {
    expect(storePartitionPrefix()).toBe('STORE#');
    expect(partitionKey(['users']).startsWith(storePartitionPrefix())).toBe(true);
  });
});

describe('itemRowKey', () => {
  it('keys an item by its namespace root and the rest of its address', () => {
    expect(itemRowKey({ namespace: ['users', 'u1'], key: 'k' })).toEqual({
      PK: partitionKey(['users', 'u1']),
      SK: sortKey(['users', 'u1'], 'k'),
    });
  });
});
