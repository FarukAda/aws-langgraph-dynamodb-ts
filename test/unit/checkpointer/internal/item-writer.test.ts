import type { Checkpoint, CheckpointMetadata, PendingWrite } from '@langchain/langgraph-checkpoint';
import { WRITES_IDX_MAP } from '@langchain/langgraph-checkpoint';

import {
  buildCheckpointItems,
  buildWriteItems,
  codecDeps,
} from '../../../../src/checkpointer/internal/item-writer';
import {
  parsePutRequest,
  parsePutWritesRequest,
} from '../../../../src/checkpointer/internal/parse';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { resolveWriteIndices } from '../../../../src/checkpointer/internal/write-index';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { checkpointItems, writeItems } from '../../../shared/helpers/parsed-inputs';

const serde = {
  dumpsTyped: (value: unknown): Promise<[string, Uint8Array]> =>
    Promise.resolve(['json', new TextEncoder().encode(JSON.stringify(value))]),
  loadsTyped: (_t: string, d: Uint8Array | string): Promise<unknown> =>
    Promise.resolve(JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d))),
};

function context(): CheckpointerContext {
  return { client: {} as never, tableName: 'ckpt', serde, logger: SILENT_LOGGER };
}

/** A context whose offloader sends every payload to S3, exposing the built key. */
function offloadingContext(): CheckpointerContext {
  const offloader = {
    shouldOffload: () => true,
    buildKey: (parts: readonly string[], objectId: string) => [...parts, objectId].join('/'),
    upload: (key: string) => key,
    deleteBatch: () => [],
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
      parsePutRequest(
        { configurable: { thread_id: 'thread-1', checkpoint_ns: '', checkpoint_id: 'parent-0' } },
        checkpoint,
        metadata,
      ),
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
    const { meta, payload } = await checkpointItems(
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

  /**
   * The checkpoint and its metadata live on different rows, so they are
   * addressed under different paths, below which sits the one object id the
   * call drew for both.
   */
  it("addresses each payload under its own row, below which the call's one object id sits", async () => {
    const ctx = offloadingContext();
    const { meta, payload } = await checkpointItems(ctx, 't1', '', checkpoint, metadata);
    const checkpointKey = s3Key({ value: payload.checkpoint });
    expect(checkpointKey).toMatch(new RegExp('^t1//ckpt-1/checkpoint/[0-9A-HJKMNP-TV-Z]{26}$'));
    const objectId = checkpointKey.slice('t1//ckpt-1/checkpoint/'.length);
    expect(s3Key({ value: meta.metadata })).toBe(`t1//ckpt-1/metadata/${objectId}`);
  });

  /**
   * A re-put of the same checkpoint — a put the caller re-issues after a lost
   * response, or a repair tool — draws an object id of its own, so it never
   * names an object an earlier put uploaded, identical bytes or not.
   */
  it('gives a re-put of identical content keys of its own', async () => {
    const ctx = offloadingContext();
    const first = await checkpointItems(ctx, 't1', '', checkpoint, metadata);
    const second = await checkpointItems(ctx, 't1', '', checkpoint, metadata);
    expect(s3Key({ value: second.payload.checkpoint })).not.toBe(
      s3Key({ value: first.payload.checkpoint }),
    );
    expect(s3Key({ value: second.meta.metadata })).not.toBe(s3Key({ value: first.meta.metadata }));
  });

  it('gives a re-put of changed content a different key', async () => {
    const ctx = offloadingContext();
    const first = await checkpointItems(ctx, 't1', '', checkpoint, metadata);
    const changed = await checkpointItems(ctx, 't1', '', checkpoint, {
      ...metadata,
      step: metadata.step + 1,
    });
    expect(s3Key({ value: changed.meta.metadata })).not.toBe(s3Key({ value: first.meta.metadata }));
  });
});

describe('buildWriteItems', () => {
  it('builds one item per write with task id, index, and channel', async () => {
    const items = await buildWriteItems(
      context(),
      parsePutWritesRequest(
        { configurable: { thread_id: 't', checkpoint_ns: '', checkpoint_id: 'ckpt-1' } },
        [
          ['messages', 'a'],
          ['counter', 5],
        ],
        'task-7',
      ),
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
    const items = await writeItems(
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

  /**
   * A write's row is thread, namespace, checkpoint, task, index and channel —
   * every segment that makes it a distinct row — with the call's `writeGroup`
   * below it as the object id.
   */
  it('addresses every write S3 key under its own row, regular or special', async () => {
    const items = await writeItems(
      offloadingContext(),
      't',
      '',
      'ckpt-1',
      'task-7',
      [
        ['regular', 'v'],
        ['__interrupt__', { value: 'paused' }],
      ],
      'group-1',
    );
    const regular = items.find((item) => item.channel === 'regular')!;
    const interrupt = items.find((item) => item.channel === '__interrupt__')!;
    expect(s3Key(regular)).toBe('t//ckpt-1/task-7/write-0/regular/group-1');
    expect(s3Key(interrupt)).toBe(
      `t//ckpt-1/task-7/write-${WRITES_IDX_MAP['__interrupt__']}/__interrupt__/group-1`,
    );
  });

  /**
   * Two calls writing the same value for the same write upload two objects, one
   * under each call's `writeGroup`, so whichever call's row survives names only
   * its own object and the other call's cleanup never touches it.
   */
  it.each<[string, PendingWrite]>([
    ['special', ['__interrupt__', { value: 'paused' }]],
    ['regular', ['ch', 'v']],
  ])('gives a repeated %s write of the same value a key per call', async (_kind, write) => {
    const ctx = offloadingContext();
    const first = await writeItems(ctx, 't', '', 'ckpt-1', 'task-7', [write], 'group-1');
    const second = await writeItems(ctx, 't', '', 'ckpt-1', 'task-7', [write], 'group-2');
    expect(s3Key(first[0]).endsWith('/group-1')).toBe(true);
    expect(s3Key(second[0])).toBe(s3Key(first[0]).replace(/group-1$/, 'group-2'));
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

describe('codecDeps', () => {
  it('hands the codec exactly the three collaborators it uses', () => {
    const serde = {} as never;
    const compression = { enabled: true } as never;
    const offloader = {} as never;
    expect(codecDeps({ serde, compression, offloader, tableName: 'x' } as never)).toEqual({
      serde,
      compression,
      offloader,
    });
  });

  it('carries absent optional collaborators through as absent', () => {
    const serde = {} as never;
    expect(codecDeps({ serde } as never)).toEqual({
      serde,
      compression: undefined,
      offloader: undefined,
    });
  });
});
