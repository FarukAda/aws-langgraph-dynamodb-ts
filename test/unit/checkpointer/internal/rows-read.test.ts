import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import {
  type CheckpointWriteItem,
  dropSupersededWrites,
  parseHeadRow,
  parseMetaRow,
  readCheckpoint,
  readMetadata,
  toPendingWrites,
} from '../../../../src/checkpointer/internal/rows';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { overlapOffloader } from '../../../shared/helpers/offload-overlap';
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

const checkpoint: Checkpoint = {
  v: 4,
  id: 'ckpt-1',
  ts: '2024-01-01T00:00:00.000Z',
  channel_values: { messages: ['hi'] },
  channel_versions: { messages: 1 },
  versions_seen: {},
};
const metadata: CheckpointMetadata = { source: 'loop', step: 3, parents: {} };

describe('rows: read', () => {
  it('round-trips a checkpoint written by buildCheckpointItems', async () => {
    const { payload } = await checkpointItems(context(), 't', '', checkpoint, metadata);
    expect(await readCheckpoint(context(), payload, 't')).toEqual(checkpoint);
  });

  it('round-trips metadata written by buildCheckpointItems', async () => {
    const { meta } = await checkpointItems(context(), 't', '', checkpoint, metadata);
    expect(await readMetadata(context(), meta, 't')).toEqual(metadata);
  });

  it('assembles pending writes as [taskId, channel, value] tuples', async () => {
    const items = await writeItems(
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

describe('dropSupersededWrites', () => {
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

  it('keeps a retry-added occurrence that never collided with an earlier row', () => {
    // Call 1 wrote `messages` once (occurrence 0, index 0). Call 2 — a retry
    // that legitimately emitted `messages` twice — re-hit index 0 (guard
    // rejected, no row) and committed a brand-new row at index 1, occurrence 1.
    // That row collided with nothing and must survive; only the read side ever
    // discarded it.
    const items = [row(0, 'messages', 'g1', 'task-1', 0), row(1, 'messages', 'g2', 'task-1', 1)];
    expect(dropSupersededWrites(items).map((item) => item.writeGroup)).toEqual(['g1', 'g2']);
  });

  it('still drops a later call re-emitting a channel at a shifted index', () => {
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

describe('toPendingWrites offloaded reads', () => {
  it('decodes offloaded pending writes up to 8 at a time, preserving order', async () => {
    const { offloader, maxInFlight } = overlapOffloader();
    const ctx = { ...context(), offloader: offloader as never };
    const items = await writeItems(
      ctx,
      't',
      '',
      'ckpt-1',
      'task-7',
      [
        ['a', 1],
        ['b', 2],
        ['c', 3],
        ['d', 4],
      ],
      'nonce-1',
    );
    const pending = await toPendingWrites(ctx, items, 't');
    expect(pending.map(([, , value]) => value)).toEqual([1, 2, 3, 4]);
    expect(maxInFlight()).toBeGreaterThan(1);
    expect(maxInFlight()).toBeLessThanOrEqual(8);
  });
});

describe('parseMetaRow refuses a row from a newer format version', () => {
  const meta = {
    PK: 'CHKPT#t',
    SK: 'META##c1',
    threadId: 't',
    checkpointNs: '',
    checkpointId: 'c1',
    metadata: { location: 'INLINE', serdeType: 'json', compressed: false, bytes: new Uint8Array() },
  };

  it('reads a row without a version, and one at the supported version', () => {
    expect(parseMetaRow(meta as never)).toBeDefined();
    expect(parseMetaRow({ ...meta, v: 1 })).toBeDefined();
  });

  /**
   * A newer row is this adapter's, not a foreign one: skipping it would report
   * the thread as shorter than it is and LangGraph would resume on top of a
   * truncated history. It fails loudly instead.
   */
  it('throws FORMAT_UNSUPPORTED rather than skipping a newer row', () => {
    expect(() => parseMetaRow({ ...meta, v: 99 })).toThrow(/format version 99/);
  });

  /**
   * The version is read before the shape. A row a newer release wrote may have
   * renamed or dropped the very attributes this narrow tests, so judging it
   * first is how a reader decides a row is foreign because it can no longer
   * read it — and answers a caller with a thread that is quietly short instead
   * of the one error that names the remedy.
   */
  it('reports a newer row whose shape this release would otherwise refuse', () => {
    expect(() => parseMetaRow({ PK: 'X', SK: 'META##c1', v: 99 })).toThrow(
      expect.objectContaining({
        code: ErrorCode.FORMAT_UNSUPPORTED,
        context: { field: 'v' },
      }),
    );
  });

  /** A row at a version this release reads keeps the skip these narrows exist for. */
  it('still skips a foreign row at a version it reads', () => {
    expect(parseMetaRow({ PK: 'X', SK: 'META##c1', v: 1 })).toBeUndefined();
    expect(parseMetaRow({ PK: 'X', SK: 'META##c1' })).toBeUndefined();
  });
});

/**
 * A META row's own attributes name the S3 scope its payloads are read under and
 * the thread the assembled tuple reports. Unbound, a writer confined to its own
 * partition could put `threadId: 'tenantB'` on a row in its own partition and
 * have `list()` hand back tenant B's offloaded payload — the cross-tenant read
 * `parseStoreRow` already refuses for store items.
 */
describe('parseMetaRow binds a row to the partition it lives in', () => {
  const row = (over: Record<string, unknown>) => ({
    PK: 'CHKPT#tenantA',
    SK: 'META#ns#c1',
    threadId: 'tenantA',
    checkpointNs: 'ns',
    checkpointId: 'c1',
    metadata: { location: 'INLINE' },
    ...over,
  });

  it('accepts a row whose identifiers agree with the key it was found at', () => {
    expect(parseMetaRow(row({}) as never)).toBeDefined();
  });

  it('rejects a row claiming a thread, namespace or checkpoint that is not its own', () => {
    expect(parseMetaRow(row({ threadId: 'tenantB' }) as never)).toBeUndefined();
    expect(parseMetaRow(row({ checkpointNs: 'other' }) as never)).toBeUndefined();
    expect(parseMetaRow(row({ checkpointId: 'c2' }) as never)).toBeUndefined();
    expect(parseMetaRow(row({ threadId: 42 }) as never)).toBeUndefined();
  });

  /**
   * The binding is judged under this release's rules, so it is judged only for
   * a row this release can read: a mismatched row a newer format wrote is
   * reported as newer rather than skipped, because the attribute the binding
   * compares may not mean there what it means here.
   */
  it('reports a mismatched row a newer format wrote rather than skipping it', () => {
    expect(() => parseMetaRow(row({ threadId: 'tenantB', v: 99 }) as never)).toThrow(
      expect.objectContaining({
        code: ErrorCode.FORMAT_UNSUPPORTED,
        context: { field: 'v' },
      }),
    );
  });

  /** At a version this release reads, a mismatched row is still skipped. */
  it('still skips a mismatched row stamped with a version it reads', () => {
    expect(parseMetaRow(row({ threadId: 'tenantB', v: 1 }) as never)).toBeUndefined();
  });
});

/**
 * `parseMetaRow` guards the one boundary where a row in this adapter's key
 * space may not have been written by it. A `metadata` of `null` passed the
 * `!== undefined` test and then raised a raw `TypeError` in the decoder.
 */
describe('parseMetaRow rejects a row whose descriptor is not one', () => {
  const base = {
    PK: 'CHKPT#t',
    SK: 'META##c',
    threadId: 't',
    checkpointId: 'c',
    checkpointNs: '',
  };

  it.each([
    ['null', null],
    ['absent', undefined],
    ['a string', 'INLINE'],
    ['a number', 7],
  ])('skips a row whose metadata is %s', (_name, metadata) => {
    expect(parseMetaRow({ ...base, metadata })).toBeUndefined();
  });

  it('accepts a row carrying a descriptor object', () => {
    expect(parseMetaRow({ ...base, metadata: { location: 'INLINE' } })).toBeDefined();
  });
});

describe('parseHeadRow', () => {
  const ctx = (warn = jest.fn()) =>
    ({ logger: { info() {}, warn, error() {}, debug() {} } }) as never;
  const head = {
    PK: 'CHKPT#t',
    SK: 'META##c1',
    threadId: 't',
    checkpointNs: '',
    checkpointId: 'c1',
    metadata: { location: 'INLINE' },
  };

  it('returns the item for a real head row', () => {
    expect(parseHeadRow(ctx(), head)?.checkpointId).toBe('c1');
  });

  /** An absent row is an ordinary answer, not something to warn about. */
  it('answers undefined silently when the read returned nothing', () => {
    const warn = jest.fn();
    expect(parseHeadRow(ctx(warn), undefined)).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  /**
   * Returning a foreign row made the assembly miss its payload and report the
   * thread as empty, so LangGraph started a new run on top of real history.
   */
  it('skips a foreign row at the head and reports its sort key', () => {
    const warn = jest.fn();
    expect(parseHeadRow(ctx(warn), { PK: 'CHKPT#t', SK: 'META##zzz' })).toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not a checkpoint meta item'), {
      sortKey: 'META##zzz',
    });
  });
});
