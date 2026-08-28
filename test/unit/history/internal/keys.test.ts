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

  it('builds MSG# sort keys from a ULID, tagged with the adapter-kind prefix', () => {
    expect(messageSortKey('01HZX')).toBe('HISTORY#MSG#01HZX');
  });

  it('exposes the MSG prefix and SESSION marker, both tagged with the adapter-kind prefix', () => {
    expect(messageSortKeyPrefix()).toBe('HISTORY#MSG#');
    expect(SESSION_SORT_KEY).toBe('HISTORY#SESSION');
  });

  it('tags every sort key so it cannot collide with a store item sharing the same partition', () => {
    // The bug this closes: store.put([sessionId], 'SESSION', ...) on a table
    // shared via DynamoDBFactory.createAll() used to collapse to the exact
    // same PK/SK as history's own per-session metadata row (sortKey(namespace,
    // key) = [...namespace.slice(1), key].join('#'), which is just 'SESSION'
    // for a single-element namespace). No unprefixed store key can produce
    // 'HISTORY#...' by accident, since '#' is forbidden in a store key/namespace
    // element (see store/internal/validation.ts's assertNoSeparator).
    expect(SESSION_SORT_KEY.startsWith('HISTORY#')).toBe(true);
    expect(messageSortKeyPrefix().startsWith('HISTORY#')).toBe(true);
  });
});
