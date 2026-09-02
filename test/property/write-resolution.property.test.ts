import { type PendingWrite, WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint';
import fc from 'fast-check';

import { dropSupersededWrites } from '../../src/checkpointer/internal/item-reader';
import { resolveWriteIndices } from '../../src/checkpointer/internal/write-index';
import type { CheckpointWriteItem } from '../../src/checkpointer/types';
import { PayloadLocation } from '../../src/shared/codec/codec';

const isSpecial = (channel: string): boolean => Object.hasOwn(WRITES_IDX_MAP, channel);
const channel = fc.oneof(
  fc.constantFrom(...Object.keys(WRITES_IDX_MAP)),
  fc.constantFrom('messages', 'branch:to:x', 'tasks', 'constructor', 'toString'),
);
const write = fc.tuple(channel, fc.jsonValue({ maxDepth: 2 })) as fc.Arbitrary<PendingWrite>;

describe('resolveWriteIndices (property)', () => {
  it('keeps regular writes at their positions, one row per special slot (last wins), and counts occurrences', () => {
    fc.assert(
      fc.property(fc.array(write, { maxLength: 40 }), (writes) => {
        const resolved = resolveWriteIndices(writes);
        const regular = resolved.filter((row) => !isSpecial(row.channel));
        const expected = writes
          .map(([name], position) => ({ name, position }))
          .filter(({ name }) => !isSpecial(name));
        expect(regular.map((row) => [row.channel, row.index])).toEqual(
          expected.map(({ name, position }) => [name, position]),
        );
        const seen = new Map<string, number>();
        for (const row of regular) {
          expect(row.occurrence).toBe(seen.get(row.channel) ?? 0);
          seen.set(row.channel, row.occurrence + 1);
        }
        const special = resolved.filter((row) => isSpecial(row.channel));
        expect(new Set(special.map((row) => row.index)).size).toBe(special.length);
        for (const row of special) {
          expect(row.index).toBe(WRITES_IDX_MAP[row.channel]);
          const last = [...writes].reverse().find(([name]) => name === row.channel);
          expect(row.value).toEqual(last?.[1]);
        }
      }),
    );
  });
});

const writeItem = fc.record({
  taskId: fc.constantFrom('t1', 't2'),
  channel: fc.constantFrom('a', 'b', 'c'),
  occurrence: fc.option(fc.nat({ max: 2 }), { nil: undefined }),
  writeGroup: fc.constantFrom('g1', 'g2', 'g3'),
  index: fc.nat({ max: 5 }),
});
const writeItems = fc.array(writeItem, { maxLength: 30 }).map((rows) =>
  rows.map((row, position): CheckpointWriteItem => ({
    PK: 'p',
    SK: `s${position}`,
    value: {
      location: PayloadLocation.INLINE,
      serdeType: 'json',
      compressed: false,
      bytes: new Uint8Array(),
    },
    ...row,
  })),
);
const identity = (row: CheckpointWriteItem): string =>
  JSON.stringify([row.taskId, row.channel, row.occurrence ?? 0]);

describe('dropSupersededWrites (property)', () => {
  it('returns an order-preserving subset holding, per identity, exactly the rows of the earliest group', () => {
    fc.assert(
      fc.property(writeItems, (items) => {
        const kept = dropSupersededWrites(items);
        expect(kept).toEqual(items.filter((row) => kept.includes(row)));
        const earliest = new Map<string, string>();
        for (const row of items) {
          const id = identity(row);
          const seen = earliest.get(id);
          if (seen === undefined || row.writeGroup < seen) earliest.set(id, row.writeGroup);
        }
        for (const row of kept) expect(row.writeGroup).toBe(earliest.get(identity(row)));
        expect(new Set(kept.map(identity))).toEqual(new Set(items.map(identity)));
      }),
    );
  });
});
