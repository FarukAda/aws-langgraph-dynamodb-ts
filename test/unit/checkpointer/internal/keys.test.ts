import {
  metaSortKey,
  metaSortKeyPrefix,
  partitionKey,
  payloadSortKey,
  writeSortKey,
  writeSortKeyPrefix,
} from '../../../../src/checkpointer/internal/keys';

describe('checkpointer keys', () => {
  it('tags the partition key with the checkpointer adapter prefix (C1, C2)', () => {
    expect(partitionKey('thread-1')).toBe('CHKPT#thread-1');
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

  it('builds WRITE sort keys with a zero-padded index, the channel, and the prefix', () => {
    expect(writeSortKey('', 'ckpt-1', 'task-9', 2, 'ch')).toBe(
      'WRITE##ckpt-1#task-9#0000000010#ch',
    );
    expect(writeSortKeyPrefix('', 'ckpt-1')).toBe('WRITE##ckpt-1#');
  });

  it('keeps two channels sharing an index in separate rows (C3)', () => {
    expect(writeSortKey('', 'c', 't', 0, 'chanA')).not.toBe(writeSortKey('', 'c', 't', 0, 'chanB'));
  });

  it('rejects a write index outside the encodable range (M8)', () => {
    expect(() => writeSortKey('', 'c', 't', -9, 'ch')).toThrow(/outside the range/);
    expect(() => writeSortKey('', 'c', 't', 1e10, 'ch')).toThrow(/outside the range/);
  });

  it('orders WRITE sort keys numerically by index (10 after 2)', () => {
    const second = writeSortKey('', 'ckpt-1', 'task-9', 2, 'ch');
    const tenth = writeSortKey('', 'ckpt-1', 'task-9', 10, 'ch');
    expect(second < tenth).toBe(true);
  });

  it('orders special negative write indices below positional ones', () => {
    const sk = (index: number): string => writeSortKey('ns', 'cp', 'task', index, 'ch');
    const ordered = [-4, -3, -2, -1, 0, 1, 2].map(sk);
    expect([...ordered].sort()).toEqual(ordered);
  });
});

describe('writeSortKey composed length (SEC-10)', () => {
  it('rejects a composed sort key over the 1024 bytes DynamoDB allows, even from capped segments', () => {
    const segment = 'x'.repeat(256);
    expect(() => writeSortKey(segment, segment, segment, 0, segment)).toThrow(
      /sort key.*1024 bytes/,
    );
  });

  it('accepts a composed sort key at the limit', () => {
    expect(() => writeSortKey('ns', 'c'.repeat(256), 't'.repeat(256), 0, 'ch')).not.toThrow();
  });
});
