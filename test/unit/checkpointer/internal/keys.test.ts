import {
  metaSortKey,
  metaSortKeyPrefix,
  partitionKey,
  payloadSortKey,
  writeSortKey,
  writeSortKeyPrefix,
} from '../../../../src/checkpointer/internal/keys';

describe('checkpointer keys', () => {
  it('uses the thread id as the partition key', () => {
    expect(partitionKey('thread-1')).toBe('thread-1');
  });

  it('builds namespaced META / PAYLOAD sort keys ordered by checkpoint id', () => {
    expect(metaSortKey('', 'ckpt-1')).toBe('META##ckpt-1');
    expect(metaSortKey('inner', 'ckpt-1')).toBe('META#inner#ckpt-1');
    expect(payloadSortKey('inner', 'ckpt-1')).toBe('PAYLOAD#inner#ckpt-1');
  });

  it('builds a META prefix for list() begins_with queries', () => {
    expect(metaSortKeyPrefix('')).toBe('META##');
    expect(metaSortKeyPrefix('inner')).toBe('META#inner#');
  });

  it('builds WRITE sort keys with a zero-padded index and the per-checkpoint prefix', () => {
    expect(writeSortKey('', 'ckpt-1', 'task-9', 2)).toBe('WRITE##ckpt-1#task-9#0000000010');
    expect(writeSortKeyPrefix('', 'ckpt-1')).toBe('WRITE##ckpt-1#');
  });

  it('orders WRITE sort keys numerically by index (10 after 2)', () => {
    const second = writeSortKey('', 'ckpt-1', 'task-9', 2);
    const tenth = writeSortKey('', 'ckpt-1', 'task-9', 10);
    expect(second < tenth).toBe(true);
  });

  it('orders special negative write indices below positional ones', () => {
    const sk = (index: number): string => writeSortKey('ns', 'cp', 'task', index);
    const ordered = [-4, -3, -2, -1, 0, 1, 2].map(sk);
    expect([...ordered].sort()).toEqual(ordered);
  });
});
