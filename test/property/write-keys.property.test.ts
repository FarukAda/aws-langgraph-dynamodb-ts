import fc from 'fast-check';

import {
  MIN_ENCODABLE_WRITE_INDEX,
  writeSortKey,
  writeSortKeyPrefix,
} from '../../src/checkpointer/internal/rows';

/** The largest index whose offset form still fits the 10-digit pad. */
const MAX_ENCODABLE_WRITE_INDEX = 10 ** 10 - 1 + MIN_ENCODABLE_WRITE_INDEX;
/** Indices reach ~1e10, beyond the 32-bit range of fc.integer, so they are drawn as bigints. */
const between = (min: number, max: number): fc.Arbitrary<number> =>
  fc.bigInt({ min: BigInt(min), max: BigInt(max) }).map(Number);
const index = between(MIN_ENCODABLE_WRITE_INDEX, MAX_ENCODABLE_WRITE_INDEX);
/** A sort-key segment: anything but the reserved separator. */
const segment = fc.stringMatching(/^[A-Za-z0-9_.:|-]{1,32}$/);

describe('writeSortKey (property)', () => {
  it('orders keys exactly like their indices, for any two indices in range', () => {
    fc.assert(
      fc.property(index, index, segment, segment, segment, (a, b, ns, cp, task) => {
        const left = writeSortKey({
          checkpointNs: ns,
          checkpointId: cp,
          taskId: task,
          index: a,
          channel: 'ch',
        });
        const right = writeSortKey({
          checkpointNs: ns,
          checkpointId: cp,
          taskId: task,
          index: b,
          channel: 'ch',
        });
        expect(left < right).toBe(a < b);
        expect(left === right).toBe(a === b);
      }),
      { numRuns: 300 },
    );
  });

  it('always lies under the checkpoint prefix that begins_with reads use', () => {
    fc.assert(
      fc.property(index, segment, segment, segment, segment, (i, ns, cp, task, channel) => {
        expect(
          writeSortKey({
            checkpointNs: ns,
            checkpointId: cp,
            taskId: task,
            index: i,
            channel,
          }).startsWith(writeSortKeyPrefix(ns, cp)),
        ).toBe(true);
      }),
    );
  });

  it('rejects every index outside the encodable range', () => {
    const outside = fc.oneof(
      between(-(10 ** 12), MIN_ENCODABLE_WRITE_INDEX - 1),
      between(MAX_ENCODABLE_WRITE_INDEX + 1, 10 ** 12),
    );
    fc.assert(
      fc.property(outside, (i) => {
        expect(() =>
          writeSortKey({
            checkpointNs: 'ns',
            checkpointId: 'cp',
            taskId: 't',
            index: i,
            channel: 'ch',
          }),
        ).toThrow(/encodable/);
      }),
    );
  });
});
