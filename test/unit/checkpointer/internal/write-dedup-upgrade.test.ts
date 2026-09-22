import { dropSupersededWrites } from '../../../../src/checkpointer/internal/write-dedup';
import type { CheckpointWriteItem } from '../../../../src/checkpointer/types';

function row(writeGroup: string | undefined, value: string): CheckpointWriteItem {
  return {
    PK: 'CHKPT#t',
    SK: `WRITE#ns#c1#task#0000000008#ch`,
    taskId: 'task',
    index: 0,
    channel: 'ch',
    occurrence: 0,
    value: { location: 'INLINE', serdeType: 'json', compressed: false, bytes: Buffer.from(value) },
    ...(writeGroup === undefined ? {} : { writeGroup }),
  } as CheckpointWriteItem;
}

describe('dropSupersededWrites across an upgrade (CKPT-11)', () => {
  /**
   * A row written before `writeGroup` existed carries none, and it is older
   * than every row that does. Keeping the raw `undefined` reversed
   * first-write-wins: a Map cannot tell a key whose value is absent from one
   * whose value *is* `undefined`, so the "nothing recorded yet" guard fired
   * again on the old row's own entry and let the newer row overwrite it — the
   * newer value won, which is the opposite of the documented contract.
   */
  it('keeps the pre-upgrade row when a newer call re-emitted the same channel', () => {
    const old = row(undefined, 'first');
    const newer = row('01JBXYZ', 'second');
    expect(dropSupersededWrites([old, newer])).toEqual([old]);
    expect(dropSupersededWrites([newer, old])).toEqual([old]);
  });

  it('still orders two rows that both carry a group', () => {
    const first = row('01AAA', 'first');
    const second = row('01BBB', 'second');
    expect(dropSupersededWrites([second, first])).toEqual([first]);
  });

  it('keeps two pre-upgrade rows of one identity rather than dropping both', () => {
    const a = row(undefined, 'a');
    const b = row(undefined, 'b');
    expect(dropSupersededWrites([a, b])).toEqual([a, b]);
  });
});
