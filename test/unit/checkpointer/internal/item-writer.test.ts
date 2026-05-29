import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import {
  buildCheckpointItems,
  buildWriteItems,
} from '../../../../src/checkpointer/internal/item-writer';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
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

const metadata: CheckpointMetadata = { source: 'loop', step: 1, parents: {} };

describe('buildCheckpointItems', () => {
  it('builds META and PAYLOAD items with the right keys and inline descriptors', async () => {
    const { meta, payload } = await buildCheckpointItems(
      context(),
      'thread-1',
      '',
      checkpoint,
      metadata,
      'parent-0',
    );
    expect(meta.PK).toBe('thread-1');
    expect(meta.SK).toBe('META##ckpt-1');
    expect(meta.checkpointId).toBe('ckpt-1');
    expect(meta.parentCheckpointId).toBe('parent-0');
    expect(meta.metadata.location).toBe(PayloadLocation.INLINE);
    expect(meta.ttl).toBeUndefined();
    expect(payload.SK).toBe('PAYLOAD##ckpt-1');
    expect(payload.checkpoint.serdeType).toBe('json');
  });

  it('sets the ttl attribute when a timestamp is supplied', async () => {
    const { meta, payload } = await buildCheckpointItems(
      context(),
      't',
      'ns',
      checkpoint,
      metadata,
      undefined,
      1750,
    );
    expect(meta.ttl).toBe(1750);
    expect(payload.ttl).toBe(1750);
    expect(meta.parentCheckpointId).toBeUndefined();
  });
});

describe('buildWriteItems', () => {
  it('builds one item per write with task id, index, and channel', async () => {
    const items = await buildWriteItems(context(), 't', '', 'ckpt-1', 'task-7', [
      ['messages', 'a'],
      ['counter', 5],
    ]);
    expect(items).toHaveLength(2);
    expect(items[0].SK).toBe('WRITE##ckpt-1#task-7#0');
    expect(items[0].channel).toBe('messages');
    expect(items[1].SK).toBe('WRITE##ckpt-1#task-7#1');
    expect(items[1].index).toBe(1);
    expect(items[1].value.serdeType).toBe('json');
  });
});
