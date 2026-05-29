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

  it('builds WRITE sort keys and the per-checkpoint WRITE prefix', () => {
    expect(writeSortKey('', 'ckpt-1', 'task-9', 2)).toBe('WRITE##ckpt-1#task-9#2');
    expect(writeSortKeyPrefix('', 'ckpt-1')).toBe('WRITE##ckpt-1#');
  });
});
