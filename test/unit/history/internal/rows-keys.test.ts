import {
  SESSION_SORT_KEY,
  historyPartitionPrefix,
  messageSortKey,
  messageSortKeyPrefix,
  sessionPartition,
  sessionRowKey,
} from '../../../../src/history/internal/rows';
import { partitionKey as storePartition } from '../../../../src/store/internal/keys';

describe('history keys', () => {
  it('tags the partition key with the chat-history adapter prefix (C1, C2)', () => {
    expect(sessionPartition('s1')).toBe('HIST#s1');
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
    // for a single-element namespace).
    //
    // The tag does not make the sort key unreachable, and an earlier note here
    // claiming it did was wrong: '#' is forbidden inside a store namespace
    // element, but the join inserts one, so store.put(['t','HISTORY'],
    // 'SESSION', ...) composes 'HISTORY#SESSION' exactly. What keeps the two
    // rows apart is the partition tag — see the partition-key disjointness
    // suite, which also pins the two table scans that must restrict on it.
    expect(SESSION_SORT_KEY.startsWith('HISTORY#')).toBe(true);
    expect(messageSortKeyPrefix().startsWith('HISTORY#')).toBe(true);
    expect(sessionPartition('t')).not.toBe(storePartition(['t', 'HISTORY']));
  });

  it('exposes the partition tag the table scan restricts on', () => {
    expect(historyPartitionPrefix()).toBe('HIST#');
    expect(sessionPartition('s1').startsWith(historyPartitionPrefix())).toBe(true);
  });
});

describe('sessionRowKey', () => {
  it("keys a session's SESSION row in the session's own partition", () => {
    expect(sessionRowKey('s1')).toEqual({ PK: sessionPartition('s1'), SK: SESSION_SORT_KEY });
  });
});
