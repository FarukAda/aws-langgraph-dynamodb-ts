import type { Checkpoint, CheckpointMetadata, PendingWrite } from '@langchain/langgraph-checkpoint';
import { WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint';

import {
  buildCheckpointItems,
  buildWriteItems,
} from '../../../../src/checkpointer/internal/item-writer';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { resolveWriteIndices } from '../../../../src/checkpointer/internal/write-index';
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
      'nonce-1',
      'parent-0',
    );
    expect(meta.PK).toBe('CHKPT#thread-1');
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
      'nonce-1',
      undefined,
      1750,
    );
    expect(meta.ttl).toBe(1750);
    expect(payload.ttl).toBe(1750);
    expect(meta.parentCheckpointId).toBeUndefined();
  });

  it('appends the per-call nonce to both S3 keys so a re-put never reuses an object', async () => {
    // Deterministic keys let a failing re-put of the same checkpoint id delete
    // the objects the first, committed put's rows still reference (CKPT-01).
    const ctx = offloadingContext();
    const first = await buildCheckpointItems(ctx, 't1', '', checkpoint, metadata, 'NONCE-A');
    const second = await buildCheckpointItems(ctx, 't1', '', checkpoint, metadata, 'NONCE-B');
    expect(s3Key({ value: first.payload.checkpoint })).toBe('t1//ckpt-1/checkpoint/NONCE-A');
    expect(s3Key({ value: first.meta.metadata })).toBe('t1//ckpt-1/metadata/NONCE-A');
    expect(s3Key({ value: second.payload.checkpoint })).toBe('t1//ckpt-1/checkpoint/NONCE-B');
    expect(s3Key({ value: second.meta.metadata })).toBe('t1//ckpt-1/metadata/NONCE-B');
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
    // Positional index, as the reference saver computes it, so writes replay
    // in the order the task emitted them; the channel segment is what keeps
    // an unrelated channel from displacing another on a retry (C3).
    expect(items[0].SK).toBe('WRITE##ckpt-1#task-7#0000000008#messages');
    expect(items[0].channel).toBe('messages');
    expect(items[1].SK).toBe('WRITE##ckpt-1#task-7#0000000009#counter');
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
    expect(interrupt.SK).toBe('WRITE##ckpt-1#task-7#0000000005#__interrupt__');
    expect(interrupt.SK < regular.SK).toBe(true);
  });

  it('appends the nonce to every write S3 key, regular or special', async () => {
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
    expect(s3Key(regular)).toBe('t//ckpt-1/task-7/write-0/regular/nonce-1');
    expect(s3Key(interrupt)).toBe(
      `t//ckpt-1/task-7/write-${WRITES_IDX_MAP['__interrupt__']}/__interrupt__/nonce-1`,
    );
  });

  it('gives a repeated special write a fresh S3 key per call, matching a regular write', async () => {
    const ctx = offloadingContext();
    const writes: PendingWrite[] = [['__interrupt__', { value: 'paused' }]];
    const first = await buildWriteItems(ctx, 't', '', 'ckpt-1', 'task-7', [...writes], 'nonce-1');
    const second = await buildWriteItems(ctx, 't', '', 'ckpt-1', 'task-7', [...writes], 'nonce-2');
    // Nonce'd now like every other write; Task 2 is what keeps this safe from
    // leaking the first call's now-superseded upload.
    expect(s3Key(second[0])).not.toBe(s3Key(first[0]));
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

describe('resolveWriteIndices', () => {
  it('treats a channel colliding with Object.prototype as regular, not special', () => {
    expect(resolveWriteIndices([['constructor', 'v']])).toEqual([
      { channel: 'constructor', value: 'v', index: 0, occurrence: 0 },
    ]);
    expect(resolveWriteIndices([['toString', 'v']])).toEqual([
      { channel: 'toString', value: 'v', index: 0, occurrence: 0 },
    ]);
  });

  it('resolves a known special channel to its WRITES_IDX_MAP slot', () => {
    expect(resolveWriteIndices([['__error__', 'boom']])).toEqual([
      { channel: '__error__', value: 'boom', index: -1, occurrence: 0 },
    ]);
  });

  it('collapses a repeated special channel last-write-wins at its fixed slot', () => {
    expect(
      resolveWriteIndices([
        ['__error__', 'first'],
        ['__error__', 'second'],
      ]),
    ).toEqual([{ channel: '__error__', value: 'second', index: -1, occurrence: 0 }]);
  });

  it('indexes regular writes by their position in the caller array (C3)', () => {
    // Position, not occurrence: this is what makes stored writes replay in the
    // order the task emitted them.
    expect(
      resolveWriteIndices([
        ['ch', 'a'],
        ['other', 'x'],
        ['ch', 'b'],
      ]),
    ).toEqual([
      { channel: 'ch', value: 'a', index: 0, occurrence: 0 },
      { channel: 'other', value: 'x', index: 1, occurrence: 0 },
      { channel: 'ch', value: 'b', index: 2, occurrence: 1 },
    ]);
  });

  it('does not recompute an index from the position of a collapsed array (C3)', () => {
    // Two ERROR writes collapse to one. The surviving regular write must keep
    // the index the *caller's* array gave it (2), not the position it happens
    // to occupy after the collapse (1) — the divergence from the reference
    // saver that the double computation introduced.
    expect(
      resolveWriteIndices([
        ['__error__', 'e1'],
        ['__error__', 'e2'],
        ['chanA', 'v'],
      ]),
    ).toEqual([
      { channel: '__error__', value: 'e2', index: -1, occurrence: 0 },
      { channel: 'chanA', value: 'v', index: 2, occurrence: 0 },
    ]);
  });

  it('orders special writes ahead of regular ones', () => {
    const resolved = resolveWriteIndices([
      ['regular', 'v'],
      ['__error__', 'e'],
    ]);
    expect(resolved.map((w) => w.channel)).toEqual(['__error__', 'regular']);
  });
});
