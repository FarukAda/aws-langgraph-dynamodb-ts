import type { Checkpoint, CheckpointMetadata, PendingWrite } from '@langchain/langgraph-checkpoint';
import { WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint';

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

/** A context whose offloader sends every payload to S3, exposing the built key. */
function offloadingContext(): CheckpointerContext {
  const offloader = {
    shouldOffload: () => true,
    buildKey: (parts: readonly string[]) => parts.join('/'),
    upload: async (key: string) => key,
    deleteBatch: async () => [],
  };
  return { ...context(), offloader: offloader as never };
}

function s3Key(item: { value: { location: PayloadLocation; s3Key?: string } }): string {
  expect(item.value.location).toBe(PayloadLocation.S3);
  return item.value.s3Key!;
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
    expect(items).toHaveLength(2);
    expect(items[0].SK).toBe('WRITE##ckpt-1#task-7#0000000008');
    expect(items[0].channel).toBe('messages');
    expect(items[1].SK).toBe('WRITE##ckpt-1#task-7#0000000009');
    expect(items[1].index).toBe(1);
    expect(items[1].value.serdeType).toBe('json');
  });

  it('indexes special channels at their fixed WRITES_IDX_MAP slot, ordered before regular writes', async () => {
    const items = await buildWriteItems(
      context(),
      't',
      '',
      'ckpt-1',
      'task-7',
      [
        ['regular', 'v'],
        ['__interrupt__', { value: 'paused' }],
      ],
      'nonce-1',
    );
    const regular = items.find((item) => item.channel === 'regular')!;
    const interrupt = items.find((item) => item.channel === '__interrupt__')!;
    expect(regular.index).toBe(0);
    expect(interrupt.index).toBe(WRITES_IDX_MAP['__interrupt__']);
    expect(interrupt.SK).toBe('WRITE##ckpt-1#task-7#0000000005');
    expect(interrupt.SK < regular.SK).toBe(true);
  });

  it('appends the nonce to a regular write S3 key but not to a special one', async () => {
    const items = await buildWriteItems(
      offloadingContext(),
      't',
      '',
      'ckpt-1',
      'task-7',
      [
        ['regular', 'v'],
        ['__interrupt__', { value: 'paused' }],
      ],
      'nonce-1',
    );
    const regular = items.find((item) => item.channel === 'regular')!;
    const interrupt = items.find((item) => item.channel === '__interrupt__')!;
    // Only regular writes take the conditional (first-write-wins) path, so only
    // they need a per-attempt key. Special writes overwrite their row in place.
    expect(s3Key(regular)).toBe('t//ckpt-1/task-7/write-0/nonce-1');
    expect(s3Key(interrupt)).toBe(`t//ckpt-1/task-7/write-${WRITES_IDX_MAP['__interrupt__']}`);
  });

  it('keeps a repeated special write on one S3 key across calls, so nothing is orphaned', async () => {
    const ctx = offloadingContext();
    const writes: PendingWrite[] = [['__interrupt__', { value: 'paused' }]];
    const first = await buildWriteItems(ctx, 't', '', 'ckpt-1', 'task-7', [...writes], 'nonce-1');
    const second = await buildWriteItems(ctx, 't', '', 'ckpt-1', 'task-7', [...writes], 'nonce-2');
    // The special item's DynamoDB row is overwritten in place; a nonce'd key
    // would leave the previous upload referenced by nothing and swept by no one.
    expect(s3Key(second[0])).toBe(s3Key(first[0]));
  });

  it('gives a repeated regular write a fresh S3 key per call', async () => {
    const ctx = offloadingContext();
    const first = await buildWriteItems(ctx, 't', '', 'ckpt-1', 'task-7', [['ch', 'v']], 'nonce-1');
    const second = await buildWriteItems(
      ctx,
      't',
      '',
      'ckpt-1',
      'task-7',
      [['ch', 'v']],
      'nonce-2',
    );
    expect(s3Key(second[0])).not.toBe(s3Key(first[0]));
  });
});
