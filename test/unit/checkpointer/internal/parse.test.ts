import type { RunnableConfig } from '@langchain/core/runnables';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';
import { expectTypeOf } from 'expect-type';

import {
  type CheckpointAddress,
  type CheckpointId,
  type CheckpointNs,
  type ListScope,
  parseCheckpointId,
  parseCheckpointNs,
  parseConfig,
  parseDeltaHistoryRequest,
  parseListScope,
  parsePutRequest,
  parsePutWritesRequest,
  parseTaskId,
  parseThreadConfig,
  parseThreadId,
  parseWriteChannel,
  type PutRequest,
  type PutWritesRequest,
  ROOT_NAMESPACE,
  type TaskId,
  type ThreadAddress,
  type ThreadId,
  type WriteChannel,
} from '../../../../src/checkpointer/internal/parse';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { MAX_PAGE_LIMIT } from '../../../../src/shared/validation/primitives';

/** Matches the `VALIDATION` refusal naming `field`. */
const refusal = (field: string) =>
  expect.objectContaining({
    code: ErrorCode.VALIDATION,
    context: expect.objectContaining({ field }),
  });

const CHECKPOINT = { id: 'ckpt-2' } as Checkpoint;
const METADATA = { source: 'loop', step: 1, parents: {} } as CheckpointMetadata;
const ADDRESSED: RunnableConfig = { configurable: { thread_id: 't', checkpoint_id: 'ckpt-1' } };
const MALFORMED = ['', '   ', 'a#b', 'a\u0000b', 42, undefined, null];
const LONG: RunnableConfig = {
  configurable: { thread_id: 't', checkpoint_ns: 'n'.repeat(256), checkpoint_id: 'i'.repeat(256) },
};

describe('the identifier parsers', () => {
  it.each([
    { field: 'thread_id', parse: parseThreadId },
    { field: 'taskId', parse: parseTaskId },
    { field: 'channel', parse: parseWriteChannel },
    { field: 'checkpoint_id', parse: (value: unknown) => parseCheckpointId(value) },
    { field: 'thread_ts', parse: (value: unknown) => parseCheckpointId(value, 'thread_ts') },
    { field: 'before', parse: (value: unknown) => parseCheckpointId(value, 'before') },
  ])('$field: returns a well-formed id and refuses a malformed one', ({ field, parse }) => {
    expect(parse('id-1')).toBe('id-1');
    for (const value of MALFORMED) expect(() => parse(value)).toThrow(refusal(field));
  });

  it('bounds a thread id as a partition key and every other id as a key segment', () => {
    expect(parseThreadId('t'.repeat(1024))).toHaveLength(1024);
    expect(() => parseThreadId('t'.repeat(1025))).toThrow(refusal('thread_id'));
    expect(parseCheckpointId('c'.repeat(256))).toHaveLength(256);
    expect(() => parseCheckpointId('c'.repeat(257))).toThrow(refusal('checkpoint_id'));
  });

  it('accepts the empty namespace, which is the root, and refuses a malformed one', () => {
    expect(parseCheckpointNs('')).toBe('');
    expect(ROOT_NAMESPACE).toBe('');
    expect(parseCheckpointNs('inner')).toBe('inner');
    for (const value of ['a#b', 'a\nb', 'n'.repeat(513), 7, undefined]) {
      expect(() => parseCheckpointNs(value)).toThrow(refusal('checkpoint_ns'));
    }
  });
});

describe('parseConfig', () => {
  it('reads a thread, leaving an unnamed namespace unnamed and the checkpoint unset', () => {
    expect(parseConfig({ configurable: { thread_id: 't' } })).toEqual({
      threadId: 't',
      checkpointNs: undefined,
      checkpointId: undefined,
      signal: undefined,
    });
  });

  it('accepts a config naming no thread, and still checks the identifiers it gives', () => {
    expect(parseConfig({})).toMatchObject({ threadId: undefined, checkpointId: undefined });
    expect(parseConfig({ configurable: { checkpoint_ns: 'ns', thread_ts: 'c1' } })).toMatchObject({
      threadId: undefined,
      checkpointNs: 'ns',
      checkpointId: 'c1',
    });
    expect(() => parseConfig({ configurable: { checkpoint_ns: 'a#b' } })).toThrow(
      refusal('checkpoint_ns'),
    );
  });

  it('reads a null namespace as the root one, named', () => {
    const parsed = parseConfig({ configurable: { thread_id: 't', checkpoint_ns: null } });
    expect(parsed.checkpointNs).toBe('');
  });

  it('treats exactly undefined, null and the empty string as no checkpoint id, then reads thread_ts', () => {
    for (const absent of [undefined, null, '']) {
      const parsed = parseConfig({ configurable: { thread_id: 't', checkpoint_id: absent } });
      expect(parsed.checkpointId).toBeUndefined();
    }
    const legacy = parseConfig({
      configurable: { thread_id: 't', checkpoint_id: '', thread_ts: 'c9' },
    });
    expect(legacy.checkpointId).toBe('c9');
    for (const present of [0, false, Number.NaN, ' ']) {
      expect(() =>
        parseConfig({ configurable: { thread_id: 't', checkpoint_id: present } }),
      ).toThrow(refusal('checkpoint_id'));
    }
    expect(() => parseConfig({ configurable: { thread_id: 't', thread_ts: 'a#b' } })).toThrow(
      refusal('thread_ts'),
    );
  });

  it('refuses a config, a configurable or a signal it cannot read, before any identifier', () => {
    for (const config of [null, undefined, 'x', 1, []]) {
      expect(() => parseConfig(config as never)).toThrow(refusal('config'));
    }
    for (const configurable of ['x', null, []]) {
      expect(() => parseConfig({ configurable } as never)).toThrow(refusal('configurable'));
    }
    expect(() => parseConfig({ configurable: { thread_id: 'a#b' }, signal: {} } as never)).toThrow(
      refusal('signal'),
    );
  });

  it('checks the thread before the namespace, and carries the signal', () => {
    expect(() => parseConfig({ configurable: { thread_id: 'a#b', checkpoint_ns: 'b#c' } })).toThrow(
      refusal('thread_id'),
    );
    const signal = new AbortController().signal;
    expect(parseConfig({ signal }).signal).toBe(signal);
  });

  /**
   * `thread_ts` is the fallback read only once `checkpoint_id` resolves to
   * absent; a valid `checkpoint_id` never falls through to it, so a malformed
   * `thread_ts` sitting beside one is never read and never refused.
   */
  it('never reads thread_ts once checkpoint_id resolves', () => {
    expect(
      parseConfig({
        configurable: { thread_id: 't', checkpoint_id: 'c1', thread_ts: 'a#b' },
      }).checkpointId,
    ).toBe('c1');
  });
});

describe('parseThreadConfig', () => {
  it('requires a thread, and defaults the namespace to the root', () => {
    expect(parseThreadConfig({ configurable: { thread_id: 't' } })).toEqual({
      address: { threadId: 't', checkpointNs: '', checkpointId: undefined },
      signal: undefined,
    });
    expect(() => parseThreadConfig({})).toThrow(refusal('thread_id'));
  });

  it('names the missing thread before a malformed namespace', () => {
    expect(() => parseThreadConfig({ configurable: { checkpoint_ns: 'a#b' } })).toThrow(
      refusal('thread_id'),
    );
  });
});

describe('parsePutRequest', () => {
  it('addresses the new checkpoint by its own id, with the config naming its parent', () => {
    const request = parsePutRequest(
      { configurable: { thread_id: 't', checkpoint_ns: 'ns', thread_ts: 'ckpt-1' } },
      CHECKPOINT,
      METADATA,
    );
    expect(request).toEqual({
      address: { threadId: 't', checkpointNs: 'ns', checkpointId: 'ckpt-2' },
      parentCheckpointId: 'ckpt-1',
      checkpoint: CHECKPOINT,
      metadata: METADATA,
      signal: undefined,
    });
    expect(request.checkpoint).toBe(CHECKPOINT);
  });

  it('refuses a missing checkpoint and a malformed id, after the config', () => {
    expect(() => parsePutRequest(ADDRESSED, null as never, METADATA)).toThrow(
      refusal('checkpoint'),
    );
    expect(() => parsePutRequest(ADDRESSED, undefined as never, METADATA)).toThrow(
      refusal('checkpoint'),
    );
    expect(() => parsePutRequest(ADDRESSED, { id: 'a#b' } as Checkpoint, METADATA)).toThrow(
      refusal('checkpoint_id'),
    );
    expect(() => parsePutRequest(null as never, null as never, METADATA)).toThrow(
      refusal('config'),
    );
  });
});

describe('parsePutWritesRequest', () => {
  it('returns the address, the task and a copy of the writes with their channels checked', () => {
    const writes: [string, unknown][] = [
      ['a', 1],
      ['b', { x: 2 }],
    ];
    const request = parsePutWritesRequest(ADDRESSED, writes, 'task-1');
    expect(request).toEqual({
      address: { threadId: 't', checkpointNs: '', checkpointId: 'ckpt-1' },
      taskId: 'task-1',
      writes: [
        ['a', 1],
        ['b', { x: 2 }],
      ],
      signal: undefined,
    });
    expect(request.writes).not.toBe(writes);
    expect(request.writes[0]).not.toBe(writes[0]);
    expect(parsePutWritesRequest(ADDRESSED, [], 'task-1').writes).toEqual([]);
  });

  it('checks the task id first, then the config, then that it names a checkpoint', () => {
    expect(() => parsePutWritesRequest(null as never, [], 'a#b')).toThrow(refusal('taskId'));
    expect(() => parsePutWritesRequest(null as never, [], 'task')).toThrow(refusal('config'));
    expect(() => parsePutWritesRequest({ configurable: { thread_id: 't' } }, [], 'task')).toThrow(
      'checkpoint_id is required to store writes',
    );
  });

  it('checks every entry is a tuple before any channel, and every channel before any key length', () => {
    expect(() => parsePutWritesRequest(ADDRESSED, 'x' as never, 'task')).toThrow(refusal('writes'));
    expect(() => parsePutWritesRequest(ADDRESSED, [['a#b', 1], 'x'] as never, 'task')).toThrow(
      'writes[1] must be a [channel, value] tuple',
    );
    expect(() =>
      parsePutWritesRequest(
        ADDRESSED,
        [
          ['ok', 1],
          ['a#b', 2],
        ],
        'task',
      ),
    ).toThrow(refusal('channel'));
    expect(() =>
      parsePutWritesRequest(
        LONG,
        [
          ['c'.repeat(256), 1],
          ['a#b', 2],
        ],
        't'.repeat(256),
      ),
    ).toThrow(refusal('channel'));
  });

  /**
   * `Array.prototype.forEach` and `.map` both skip a hole in a sparse array
   * instead of visiting it, so a naive per-entry check let a hole slide
   * through unparsed to the `WriteChannel` brand. Indexed access reads a hole
   * as `undefined`, which is not an array either, and refuses it the same way
   * as any other non-tuple entry. Built with `Array(2)` rather than a sparse
   * literal (`[, x]`), which lint forbids outright.
   */
  it('refuses a hole in a sparse writes array rather than skipping it', () => {
    const sparse: [string, unknown][] = new Array(2) as [string, unknown][];
    sparse[1] = ['a', 1];
    expect(() => parsePutWritesRequest(ADDRESSED, sparse, 'task')).toThrow(
      'writes[0] must be a [channel, value] tuple',
    );
    expect(() => parsePutWritesRequest(ADDRESSED, sparse, 'task')).toThrow(refusal('writes'));
  });

  it('refuses a write whose composed sort key passes the cap, before anything is encoded', () => {
    const oversized = () => parsePutWritesRequest(LONG, [['c'.repeat(256), 1]], 't'.repeat(256));
    expect(oversized).toThrow(/compose a \d+-byte sort key; DynamoDB caps sort keys at 1024 bytes/);
    expect(oversized).toThrow(refusal('sortKey'));
    expect(parsePutWritesRequest(LONG, [['c', 1]], 't'.repeat(256)).writes).toEqual([['c', 1]]);
  });
});

describe('parseListScope', () => {
  it('reads the scope of a thread and a namespace', () => {
    expect(parseListScope({ configurable: { thread_id: 't', checkpoint_ns: 'ns' } })).toEqual({
      threadId: 't',
      checkpointNs: 'ns',
      checkpointId: undefined,
      before: undefined,
      filter: undefined,
      limit: undefined,
      signal: undefined,
    });
  });

  it('leaves the thread and the namespace unset when the config names neither', () => {
    expect(parseListScope({}, {})).toMatchObject({ threadId: undefined, checkpointNs: undefined });
  });

  it('reads limit, before and filter', () => {
    const filter = { source: 'loop' };
    const before = { configurable: { checkpoint_id: 'c0' } };
    expect(parseListScope(ADDRESSED, { limit: 0, before, filter })).toMatchObject({
      limit: 0,
      before: 'c0',
      filter,
    });
    expect(parseListScope(ADDRESSED, { before: {} }).before).toBeUndefined();
    const emptyBound = { configurable: { checkpoint_id: '' } };
    expect(parseListScope(ADDRESSED, { before: emptyBound }).before).toBeUndefined();
  });

  it('refuses each malformed option, after the config', () => {
    const malformedBound = { configurable: { checkpoint_id: 'a#b' } };
    expect(() => parseListScope(ADDRESSED, { limit: -1 })).toThrow(refusal('limit'));
    expect(() => parseListScope(ADDRESSED, { limit: MAX_PAGE_LIMIT + 1 })).toThrow(
      refusal('limit'),
    );
    expect(() => parseListScope(ADDRESSED, { before: 'x' as never })).toThrow(refusal('before'));
    expect(() => parseListScope(ADDRESSED, { before: malformedBound })).toThrow(refusal('before'));
    expect(() => parseListScope(ADDRESSED, { filter: 'x' as never })).toThrow(refusal('filter'));
    expect(() => parseListScope(ADDRESSED, { bogus: 1 } as never)).toThrow(
      refusal('options.bogus'),
    );
    expect(() => parseListScope('x' as never, { bogus: 1 } as never)).toThrow(refusal('config'));
  });
});

describe('parseDeltaHistoryRequest', () => {
  it('checks the shape only: the ids are read later, and only when a channel is named', () => {
    const config: RunnableConfig = { configurable: { thread_id: 'a#b' } };
    const channels = ['messages'];
    const request = parseDeltaHistoryRequest({ config, channels });
    expect(request.config).toBe(config);
    expect(request.channels).toEqual(['messages']);
    expect(request.channels).not.toBe(channels);
  });

  it('refuses options, a config and channels it cannot read', () => {
    expect(() => parseDeltaHistoryRequest(null as never)).toThrow(refusal('options'));
    expect(() => parseDeltaHistoryRequest({ config: {}, channels: [], x: 1 } as never)).toThrow(
      refusal('options.x'),
    );
    expect(() => parseDeltaHistoryRequest({ config: null as never, channels: [] })).toThrow(
      refusal('config'),
    );
    expect(() => parseDeltaHistoryRequest({ config: {}, channels: 'm' as never })).toThrow(
      refusal('channels'),
    );
  });

  /**
   * `Array.prototype.some` skips a hole in a sparse array instead of visiting
   * it, and `Array.prototype.slice` carried it forward instead of filling it,
   * so a hole used to pass `parseStringArray` and reach the walk as a literal
   * `undefined` channel. Built with `Array(2)` rather than a sparse literal,
   * which lint forbids outright.
   */
  it('refuses a hole in a sparse channels array rather than skipping it', () => {
    const channels: string[] = new Array(2) as string[];
    channels[1] = 'a';
    const config: RunnableConfig = { configurable: { thread_id: 'a#b' } };
    expect(() => parseDeltaHistoryRequest({ config, channels })).toThrow(
      'channels[0] must be a string',
    );
    expect(() => parseDeltaHistoryRequest({ config, channels })).toThrow(refusal('channels'));
  });
});

describe('the parsed types', () => {
  it('cannot be forged from a plain string, and are what the parsers return', () => {
    expectTypeOf<string>().not.toMatchTypeOf<ThreadId>();
    expectTypeOf<string>().not.toMatchTypeOf<CheckpointNs>();
    expectTypeOf<string>().not.toMatchTypeOf<CheckpointId>();
    expectTypeOf<string>().not.toMatchTypeOf<TaskId>();
    expectTypeOf<string>().not.toMatchTypeOf<WriteChannel>();
    expectTypeOf<ThreadId>().toMatchTypeOf<string>();
    expectTypeOf(parseThreadConfig(ADDRESSED).address).toEqualTypeOf<ThreadAddress>();
    const put = parsePutRequest(ADDRESSED, CHECKPOINT, METADATA);
    expectTypeOf(put).toEqualTypeOf<PutRequest>();
    expectTypeOf(put.address).toEqualTypeOf<CheckpointAddress>();
    expectTypeOf(parsePutWritesRequest(ADDRESSED, [], 't')).toEqualTypeOf<PutWritesRequest>();
    expectTypeOf(parseListScope(ADDRESSED)).toEqualTypeOf<ListScope>();
  });
});
