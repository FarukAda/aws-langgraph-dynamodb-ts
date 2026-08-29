import { partitionKey as checkpointerPartition } from '../../../src/checkpointer/internal/keys';
import { sessionPartition } from '../../../src/history/internal/keys';
import { partitionKey as storePartition } from '../../../src/store/internal/keys';

/**
 * C1/C2: every adapter used to write a bare, untagged caller-supplied string
 * as its partition key, so one identifier reused across adapters on a table
 * shared via `DynamoDBFactory.createAll()` put unrelated rows in one
 * partition. `deleteThread`/`history.clear` then deleted the whole partition,
 * and composed sort keys could collide byte-for-byte. Adapter tags make the
 * three key spaces disjoint by construction.
 */
describe('cross-adapter partition-key disjointness (C1, C2)', () => {
  const shared = 'conv-1';

  it('gives one identifier three distinct partitions, one per adapter', () => {
    const keys = [
      checkpointerPartition(shared),
      sessionPartition(shared),
      storePartition([shared]),
    ];
    expect(new Set(keys).size).toBe(3);
  });

  it('tags each partition with its own adapter', () => {
    expect(checkpointerPartition(shared)).toBe('CHKPT#conv-1');
    expect(sessionPartition(shared)).toBe('HIST#conv-1');
    expect(storePartition([shared, 'docs'])).toBe('STORE#conv-1');
  });

  it('cannot be made to collide by embedding another adapter tag in the identifier', () => {
    // The tags differ in their first character, so no suffix can bridge them —
    // and `#` is rejected inside every identifier anyway (see validateIdentifier).
    expect(checkpointerPartition('HIST#x')).not.toBe(sessionPartition('x'));
    expect(storePartition(['CHKPT#x'])).not.toBe(checkpointerPartition('x'));
    expect(sessionPartition('STORE#x')).not.toBe(storePartition(['x']));
  });
});
