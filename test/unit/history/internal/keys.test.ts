import {
  SESSION_SORT_KEY,
  messageSortKey,
  messageSortKeyPrefix,
  sessionPartition,
} from '../../../../src/history/internal/keys';

describe('history keys', () => {
  it('partitions by session id', () => {
    expect(sessionPartition('s1')).toBe('s1');
  });

  it('builds MSG# sort keys from a ULID', () => {
    expect(messageSortKey('01HZX')).toBe('MSG#01HZX');
  });

  it('exposes the MSG prefix and SESSION marker', () => {
    expect(messageSortKeyPrefix()).toBe('MSG#');
    expect(SESSION_SORT_KEY).toBe('SESSION');
  });
});
