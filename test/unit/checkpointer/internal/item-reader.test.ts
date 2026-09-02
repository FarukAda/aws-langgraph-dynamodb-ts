import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import {
  dropSupersededWrites,
  readCheckpoint,
  readMetadata,
  toPendingWrites,
} from '../../../../src/checkpointer/internal/item-reader';
import {
  buildCheckpointItems,
  buildWriteItems,
} from '../../../../src/checkpointer/internal/item-writer';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import type { CheckpointWriteItem } from '../../../../src/checkpointer/types';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';

const serde = {
  dumpsTyped: async (value: unknown): Promise<[string, Uint8Array]> => [
    'json',
    new TextEncoder().encode(JSON.stringify(value)),
  ],
  loadsTyped: async (_t: string, d: Uint8Array | string): Promise<unknown> =>
    JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d)),
};

function context(): CheckpointerContext {
  return { client: {} as never, tableName: 'ckpt', serde, logger: SILENT_LOGGER };
}

const checkpoint: Checkpoint = {
  v: 4,
  id: 'ckpt-1',
  ts: '2024-01-01T00:00:00.000Z',
  channel_values: { messages: ['hi'] },
  channel_versions: { messages: 1 },
  versions_seen: {},
};
const metadata: CheckpointMetadata = { source: 'loop', step: 3, parents: {} };

describe('item-reader', () => {
  it('round-trips the checkpoint written by the item-writer', async () => {
    const { payload } = await buildCheckpointItems(
      context(),
      't',
      '',
      checkpoint,
      metadata,
      'nonce-1',
    );
    expect(await readCheckpoint(context(), payload, 't')).toEqual(checkpoint);
  });

  it('round-trips the metadata written by the item-writer', async () => {
    const { meta } = await buildCheckpointItems(
      context(),
      't',
      '',
      checkpoint,
      metadata,
      'nonce-1',
    );
    expect(await readMetadata(context(), meta, 't')).toEqual(metadata);
  });

  it('assembles pending writes as [taskId, channel, value] tuples', async () => {
    const items = await buildWriteItems(
      context(),
      't',
      '',
      'ckpt-1',
      'task-7',
      [
        ['messages', 'a'],
        ['counter', 5],
      ],
      'nonce-1',
    );
    const pending = await toPendingWrites(context(), items, 't');
    expect(pending).toEqual([
      ['task-7', 'messages', 'a'],
      ['task-7', 'counter', 5],
    ]);
  });
});

describe('dropSupersededWrites (C3)', () => {
  const row = (
    index: number,
    channel: string,
    writeGroup: string,
    taskId = 'task-1',
    occurrence = 0,
  ): CheckpointWriteItem => ({
    PK: 'CHKPT#t',
    SK: `WRITE##c1#${taskId}#${String(index + 8).padStart(10, '0')}#${channel}`,
    taskId,
    index,
    channel,
    writeGroup,
    occurrence,
    value: {
      location: PayloadLocation.INLINE,
      serdeType: 'json',
      compressed: false,
      bytes: new Uint8Array(),
    },
  });

  it('keeps every value a single call wrote to one channel', () => {
    // A task emitting two Sends writes the same channel twice in one call;
    // both values must survive.
    const items = [
      row(0, '__pregel_tasks', 'g1', 'task-1', 0),
      row(1, '__pregel_tasks', 'g1', 'task-1', 1),
    ];
    expect(dropSupersededWrites(items)).toHaveLength(2);
  });

  it('drops a channel a later call re-emitted after an earlier call committed it', () => {
    // A retried task whose write mix changed places chanA at a second index.
    // Replaying it twice would double-count an accumulating channel.
    const items = [row(0, 'chanA', 'g1'), row(0, 'chanB', 'g2'), row(1, 'chanA', 'g2')];
    const kept = dropSupersededWrites(items);
    expect(kept.map((item) => [item.channel, item.writeGroup])).toEqual([
      ['chanA', 'g1'],
      ['chanB', 'g2'],
    ]);
  });

  it('scopes the rule to one task, never across tasks', () => {
    const items = [row(0, 'chanA', 'g1', 'task-1'), row(0, 'chanA', 'g2', 'task-2')];
    expect(dropSupersededWrites(items)).toHaveLength(2);
  });

  it('keeps the earliest call when a later one placed the channel at a LOWER index', () => {
    // A retry that emits fewer writes than the original moves an
    // already-committed channel to a smaller index, so it sorts *ahead* of the
    // original row. Picking whichever row is encountered first would then hand
    // back the later call's value — last-write-wins, the opposite of the
    // contract. Groups are time-ordered, so the earliest one is selectable.
    const items = [
      row(0, 'chanA', 'g2-later'),
      row(0, 'chanX', 'g1-earlier'),
      row(1, 'chanA', 'g1-earlier'),
    ];
    const kept = dropSupersededWrites(items);
    expect(kept.map((item) => [item.channel, item.writeGroup])).toEqual([
      ['chanX', 'g1-earlier'],
      ['chanA', 'g1-earlier'],
    ]);
  });

  it('is a no-op for a single call writing distinct channels', () => {
    const items = [row(0, 'a', 'g1'), row(1, 'b', 'g1'), row(2, 'c', 'g1')];
    expect(dropSupersededWrites(items)).toHaveLength(3);
  });

  it('keeps a retry-added occurrence that never collided with an earlier row (F1)', () => {
    // Call 1 wrote `messages` once (occurrence 0, index 0). Call 2 — a retry
    // that legitimately emitted `messages` twice — re-hit index 0 (guard
    // rejected, no row) and committed a brand-new row at index 1, occurrence 1.
    // That row collided with nothing and must survive; only the read side ever
    // discarded it.
    const items = [row(0, 'messages', 'g1', 'task-1', 0), row(1, 'messages', 'g2', 'task-1', 1)];
    expect(dropSupersededWrites(items).map((item) => item.writeGroup)).toEqual(['g1', 'g2']);
  });

  it('still drops a later call re-emitting a channel at a shifted index (C3)', () => {
    // Same channel, same occurrence, two different calls: the later one is a
    // superseding duplicate and must go.
    const items = [row(0, 'B', 'g2', 'task-1', 0), row(1, 'B', 'g1', 'task-1', 0)];
    expect(dropSupersededWrites(items).map((item) => item.index)).toEqual([1]);
  });

  it('resolves a reordered retry to the earliest call per channel occurrence', () => {
    // Call 1: [A, B]. Call 2 (retry): [B, A]. All four rows exist.
    const items = [
      row(0, 'A', 'g1', 'task-1', 0),
      row(0, 'B', 'g2', 'task-1', 0),
      row(1, 'A', 'g2', 'task-1', 0),
      row(1, 'B', 'g1', 'task-1', 0),
    ];
    expect(dropSupersededWrites(items).map((item) => `${item.channel}${item.index}`)).toEqual([
      'A0',
      'B1',
    ]);
  });

  it('treats a row written before 0.9.0 (no occurrence) as occurrence 0', () => {
    const legacy = row(0, 'messages', 'g1', 'task-1', 0);
    delete legacy.occurrence;
    const items = [legacy, row(1, 'messages', 'g2', 'task-1', 0)];
    expect(dropSupersededWrites(items).map((item) => item.writeGroup)).toEqual(['g1']);
  });

  it('separates identities per task', () => {
    const items = [row(0, 'messages', 'g1', 'task-1', 0), row(0, 'messages', 'g2', 'task-2', 0)];
    expect(dropSupersededWrites(items)).toHaveLength(2);
  });
});
