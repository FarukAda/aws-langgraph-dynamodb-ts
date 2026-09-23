import {
  checkpointerPartitionPrefix,
  checkpointRowDescriptors,
  checkpointRowKind,
  checkpointRowUnit,
  isCheckpointerSortKey,
  metaAnyNamespacePrefix,
  metaRowKey,
  metaSortKey,
  metaSortKeyPrefix,
  partitionKey,
  payloadRowKey,
  payloadSortKey,
  writeSortKey,
  writeSortKeyBytes,
  writeSortKeyPrefix,
} from '../../../../src/checkpointer/internal/rows';
import { PayloadLocation } from '../../../../src/shared/codec/codec';

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
    expect(
      writeSortKey({
        checkpointNs: '',
        checkpointId: 'ckpt-1',
        taskId: 'task-9',
        index: 2,
        channel: 'ch',
      }),
    ).toBe('WRITE##ckpt-1#task-9#0000000010#ch');
    expect(writeSortKeyPrefix('', 'ckpt-1')).toBe('WRITE##ckpt-1#');
  });

  it('keeps two channels sharing an index in separate rows (C3)', () => {
    expect(
      writeSortKey({
        checkpointNs: '',
        checkpointId: 'c',
        taskId: 't',
        index: 0,
        channel: 'chanA',
      }),
    ).not.toBe(
      writeSortKey({
        checkpointNs: '',
        checkpointId: 'c',
        taskId: 't',
        index: 0,
        channel: 'chanB',
      }),
    );
  });

  /**
   * Padding a fraction produced `00000009.5`, a sort key that no longer orders
   * numerically — the whole point of the fixed-width encoding.
   */
  it('rejects a write index that is not an integer', () => {
    expect(() =>
      writeSortKey({
        checkpointNs: '',
        checkpointId: 'c1',
        taskId: 'task',
        index: 1.5,
        channel: 'ch',
      }),
    ).toThrow(/encodable/);
  });

  it('rejects a write index outside the encodable range (M8)', () => {
    expect(() =>
      writeSortKey({ checkpointNs: '', checkpointId: 'c', taskId: 't', index: -9, channel: 'ch' }),
    ).toThrow(/encodable/);
    expect(() =>
      writeSortKey({
        checkpointNs: '',
        checkpointId: 'c',
        taskId: 't',
        index: 1e10,
        channel: 'ch',
      }),
    ).toThrow(/encodable/);
  });

  it('orders WRITE sort keys numerically by index (10 after 2)', () => {
    const second = writeSortKey({
      checkpointNs: '',
      checkpointId: 'ckpt-1',
      taskId: 'task-9',
      index: 2,
      channel: 'ch',
    });
    const tenth = writeSortKey({
      checkpointNs: '',
      checkpointId: 'ckpt-1',
      taskId: 'task-9',
      index: 10,
      channel: 'ch',
    });
    expect(second < tenth).toBe(true);
  });

  it('orders special negative write indices below positional ones', () => {
    const sk = (index: number): string =>
      writeSortKey({
        checkpointNs: 'ns',
        checkpointId: 'cp',
        taskId: 'task',
        index,
        channel: 'ch',
      });
    const ordered = [-4, -3, -2, -1, 0, 1, 2].map(sk);
    expect([...ordered].sort()).toEqual(ordered);
  });
});

describe('the composed WRITE sort key (SEC-10)', () => {
  it('is measured, not refused, by the key builder: the parser refuses it before anything is encoded', () => {
    const segment = 'x'.repeat(256);
    expect(() =>
      writeSortKey({
        checkpointNs: segment,
        checkpointId: segment,
        taskId: segment,
        index: 0,
        channel: segment,
      }),
    ).not.toThrow();
    expect(
      writeSortKeyBytes({
        checkpointNs: segment,
        checkpointId: segment,
        taskId: segment,
        channel: segment,
      }),
    ).toBeGreaterThan(1024);
  });

  it('fits at the limit', () => {
    expect(
      writeSortKeyBytes({
        checkpointNs: 'ns',
        checkpointId: 'c'.repeat(256),
        taskId: 't'.repeat(256),
        channel: 'ch',
      }),
    ).toBeLessThanOrEqual(1024);
  });
});

describe('writeSortKeyBytes', () => {
  it('measures the WRITE sort key, which is as long at every index a write can take', () => {
    const bytes = writeSortKeyBytes({
      checkpointNs: 'ns',
      checkpointId: 'cp',
      taskId: 'task',
      channel: 'ch',
    });
    expect(bytes).toBe(
      Buffer.byteLength(
        writeSortKey({
          checkpointNs: 'ns',
          checkpointId: 'cp',
          taskId: 'task',
          index: 0,
          channel: 'ch',
        }),
        'utf8',
      ),
    );
    expect(bytes).toBe(
      Buffer.byteLength(
        writeSortKey({
          checkpointNs: 'ns',
          checkpointId: 'cp',
          taskId: 'task',
          index: -4,
          channel: 'ch',
        }),
        'utf8',
      ),
    );
    expect(bytes).toBe(
      Buffer.byteLength(
        writeSortKey({
          checkpointNs: 'ns',
          checkpointId: 'cp',
          taskId: 'task',
          index: 99,
          channel: 'ch',
        }),
        'utf8',
      ),
    );
  });

  it('measures past the cap without refusing, so a parser can name the cap itself', () => {
    const segment = 'x'.repeat(256);
    expect(
      writeSortKeyBytes({
        checkpointNs: segment,
        checkpointId: segment,
        taskId: segment,
        channel: segment,
      }),
    ).toBeGreaterThan(1024);
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
    expect(
      isCheckpointerSortKey(
        writeSortKey({
          checkpointNs: '',
          checkpointId: 'c1',
          taskId: 'task',
          index: 0,
          channel: 'ch',
        }),
      ),
    ).toBe(true);
    expect(isCheckpointerSortKey('HISTORY#SESSION')).toBe(false);
    expect(isCheckpointerSortKey('u1#profile')).toBe(false);
    expect(isCheckpointerSortKey('META')).toBe(false);
  });
});

describe('the keys of a stored checkpoint', () => {
  const at = { threadId: 't', checkpointNs: 'ns', checkpointId: 'c1' };

  it('keys its META and PAYLOAD rows in one partition, each by its own sort key', () => {
    expect(metaRowKey(at)).toEqual({ PK: partitionKey('t'), SK: metaSortKey('ns', 'c1') });
    expect(payloadRowKey(at)).toEqual({ PK: partitionKey('t'), SK: payloadSortKey('ns', 'c1') });
  });
});

describe('what a thread delete reads off a row', () => {
  const sortKey = writeSortKey({
    checkpointNs: 'ns',
    checkpointId: 'c1',
    taskId: 'task',
    index: 0,
    channel: 'a',
  });

  it('names the checkpoint a row belongs to and the kind of row it is', () => {
    const row = { PK: partitionKey('t'), SK: sortKey };
    expect(checkpointRowUnit(row)).toBe('ns#c1');
    expect(checkpointRowKind(row)).toBe('WRITE');
  });

  it('names each offloaded payload a row holds by the attribute holding it', () => {
    const descriptor = {
      location: PayloadLocation.S3,
      s3Key: 'k',
      serdeType: 'json',
      compressed: false,
    };
    expect(
      checkpointRowDescriptors({ PK: 'p', SK: sortKey, metadata: descriptor, value: null }),
    ).toEqual([{ attribute: 'metadata', descriptor }]);
  });
});
