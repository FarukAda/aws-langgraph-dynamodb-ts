import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import {
  readCheckpoint,
  readMetadata,
  toPendingWrites,
} from '../../../../src/checkpointer/internal/item-reader';
import {
  buildCheckpointItems,
  buildWriteItems,
} from '../../../../src/checkpointer/internal/item-writer';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
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
    const items = await buildWriteItems(context(), 't', '', 'ckpt-1', 'task-7', [
      ['messages', 'a'],
      ['counter', 5],
    ]);
    const pending = await toPendingWrites(context(), items);
    expect(pending).toEqual([
      ['task-7', 'messages', 'a'],
      ['task-7', 'counter', 5],
    ]);
  });
});
