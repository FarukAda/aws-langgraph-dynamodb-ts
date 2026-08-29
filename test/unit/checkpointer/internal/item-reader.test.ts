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
    const { payload } = await buildCheckpointItems(context(), 't', '', checkpoint, metadata);
    expect(await readCheckpoint(context(), payload)).toEqual(checkpoint);
  });

  it('round-trips the metadata written by the item-writer', async () => {
    const { meta } = await buildCheckpointItems(context(), 't', '', checkpoint, metadata);
    expect(await readMetadata(context(), meta)).toEqual(metadata);
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
    const pending = await toPendingWrites(context(), items);
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
  ): CheckpointWriteItem => ({
    PK: 'CHKPT#t',
    SK: `WRITE##c1#${taskId}#${String(index + 8).padStart(10, '0')}#${channel}`,
    taskId,
    index,
    channel,
    writeGroup,
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
    const items = [row(0, '__pregel_tasks', 'g1'), row(1, '__pregel_tasks', 'g1')];
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

  it('is a no-op for a single call writing distinct channels', () => {
    const items = [row(0, 'a', 'g1'), row(1, 'b', 'g1'), row(2, 'c', 'g1')];
    expect(dropSupersededWrites(items)).toHaveLength(3);
  });
});
