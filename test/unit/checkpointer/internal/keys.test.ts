import {
  checkpointerPartitionPrefix,
  isCheckpointerSortKey,
  metaAnyNamespacePrefix,
  metaSortKey,
  metaSortKeyPrefix,
  partitionKey,
  payloadSortKey,
  writeSortKey,
  writeSortKeyBytes,
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

  /**
   * Padding a fraction produced `00000009.5`, a sort key that no longer orders
   * numerically — the whole point of the fixed-width encoding.
   */
  it('rejects a write index that is not an integer', () => {
    expect(() => writeSortKey('', 'c1', 'task', 1.5, 'ch')).toThrow(/encodable/);
  });

  it('rejects a write index outside the encodable range (M8)', () => {
    expect(() => writeSortKey('', 'c', 't', -9, 'ch')).toThrow(/encodable/);
    expect(() => writeSortKey('', 'c', 't', 1e10, 'ch')).toThrow(/encodable/);
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

describe('the composed WRITE sort key (SEC-10)', () => {
  it('is measured, not refused, by the key builder: the parser refuses it before anything is encoded', () => {
    const segment = 'x'.repeat(256);
    expect(() => writeSortKey(segment, segment, segment, 0, segment)).not.toThrow();
    expect(writeSortKeyBytes(segment, segment, segment, segment)).toBeGreaterThan(1024);
  });

  it('fits at the limit', () => {
    expect(writeSortKeyBytes('ns', 'c'.repeat(256), 't'.repeat(256), 'ch')).toBeLessThanOrEqual(
      1024,
    );
  });
});

describe('writeSortKeyBytes', () => {
  it('measures the WRITE sort key, which is as long at every index a write can take', () => {
    const bytes = writeSortKeyBytes('ns', 'cp', 'task', 'ch');
    expect(bytes).toBe(Buffer.byteLength(writeSortKey('ns', 'cp', 'task', 0, 'ch'), 'utf8'));
    expect(bytes).toBe(Buffer.byteLength(writeSortKey('ns', 'cp', 'task', -4, 'ch'), 'utf8'));
    expect(bytes).toBe(Buffer.byteLength(writeSortKey('ns', 'cp', 'task', 99, 'ch'), 'utf8'));
  });

  it('measures past the cap without refusing, so a parser can name the cap itself', () => {
    const segment = 'x'.repeat(256);
    expect(writeSortKeyBytes(segment, segment, segment, segment)).toBeGreaterThan(1024);
  });
});

describe('checkpointer key-space tags', () => {
  it('exposes the partition tag every checkpointer row starts with', () => {
    expect(checkpointerPartitionPrefix()).toBe('CHKPT#');
    expect(partitionKey('t').startsWith(checkpointerPartitionPrefix())).toBe(true);
  });

  /** A list without a namespace spans every namespace of the thread. */
  it('exposes a META prefix that spans every namespace', () => {
    expect(metaAnyNamespacePrefix()).toBe('META#');
    expect(metaSortKey('ns', 'c1').startsWith(metaAnyNamespacePrefix())).toBe(true);
    expect(metaSortKey('', 'c1').startsWith(metaAnyNamespacePrefix())).toBe(true);
  });

  /**
   * A partition-wide delete has no sort-key condition, so this is what keeps it
   * from wiping a row another adapter left in the partition.
   */
  it('owns its three row kinds and nothing else', () => {
    expect(isCheckpointerSortKey(metaSortKey('', 'c1'))).toBe(true);
    expect(isCheckpointerSortKey(payloadSortKey('', 'c1'))).toBe(true);
    expect(isCheckpointerSortKey(writeSortKey('', 'c1', 'task', 0, 'ch'))).toBe(true);
    expect(isCheckpointerSortKey('HISTORY#SESSION')).toBe(false);
    expect(isCheckpointerSortKey('u1#profile')).toBe(false);
    expect(isCheckpointerSortKey('META')).toBe(false);
  });
});
