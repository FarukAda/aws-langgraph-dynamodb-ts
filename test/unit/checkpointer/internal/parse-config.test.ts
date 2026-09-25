import type { RunnableConfig } from '@langchain/core/runnables';

import {
  parseConfig,
  parseDeltaHistoryRequest,
  parseThreadConfig,
} from '../../../../src/checkpointer/internal/parse';
import { ErrorCode } from '../../../../src/shared/errors/error-code';

/** Every reader below refuses the same non-object configs the same way. */
const NON_OBJECT_CONFIGS = [null, undefined, 'x', 1, []];

/** The identifiers a config naming no thread resolves to, in the shape these cases assert. */
function threadless(config: RunnableConfig) {
  const { checkpointNs, checkpointId } = parseConfig(config);
  return { threadId: '', checkpointNs: checkpointNs ?? '', checkpointId };
}

describe('parseThreadConfig', () => {
  it('extracts thread id, defaulting namespace to empty and id to undefined', () => {
    expect(parseThreadConfig({ configurable: { thread_id: 't1' } }).address).toEqual({
      threadId: 't1',
      checkpointNs: '',
      checkpointId: undefined,
    });
  });

  it('passes through namespace and checkpoint id when present', () => {
    expect(
      parseThreadConfig({
        configurable: { thread_id: 't1', checkpoint_ns: 'inner', checkpoint_id: 'c9' },
      }).address,
    ).toEqual({ threadId: 't1', checkpointNs: 'inner', checkpointId: 'c9' });
  });

  it('throws a VALIDATION error when thread_id is missing', () => {
    try {
      parseThreadConfig({ configurable: {} });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code: ErrorCode }).code).toBe(ErrorCode.VALIDATION);
    }
  });

  it('throws when configurable is absent entirely', () => {
    expect(() => parseThreadConfig({})).toThrow(/thread_id/);
  });

  /**
   * `config.configurable` used to be read straight off the argument, so a
   * `null` or `undefined` config reached a bare `TypeError` from that
   * property access instead of naming the caller's mistake.
   */
  it('refuses a non-object config, naming it', () => {
    for (const config of NON_OBJECT_CONFIGS) {
      expect(() => parseThreadConfig(config as never)).toThrow(
        expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'config' } }),
      );
    }
  });

  it('throws a VALIDATION error when an id contains the reserved separator', () => {
    expect(() => parseThreadConfig({ configurable: { thread_id: 'a#b' } })).toThrow();
    expect(() =>
      parseThreadConfig({ configurable: { thread_id: 't', checkpoint_ns: 'n#s' } }),
    ).toThrow();
    expect(() =>
      parseThreadConfig({ configurable: { thread_id: 't', checkpoint_id: 'c#1' } }),
    ).toThrow();
  });
});

describe('parseThreadConfig falsy checkpoint_id', () => {
  it('treats null and the empty string as "latest" like the reference savers', () => {
    expect(
      parseThreadConfig({ configurable: { thread_id: 't', checkpoint_id: null as never } }).address
        .checkpointId,
    ).toBeUndefined();
    expect(
      parseThreadConfig({ configurable: { thread_id: 't', checkpoint_id: '' } }).address
        .checkpointId,
    ).toBeUndefined();
  });

  /**
   * `0`, `false` and `NaN` are falsy in JS but none can be a checkpoint id.
   * "No id" is exactly `undefined`, `null` or `''`, so a bare truthiness check
   * (the code's previous shape) would misread these as "no bound" instead of
   * refusing them.
   */
  it('refuses 0, false and NaN rather than treating them as absent', () => {
    for (const checkpointId of [0, false, Number.NaN]) {
      expect(() =>
        parseThreadConfig({
          configurable: { thread_id: 't', checkpoint_id: checkpointId as never },
        }),
      ).toThrow(
        expect.objectContaining({
          code: ErrorCode.VALIDATION,
          context: { field: 'checkpoint_id' },
        }),
      );
    }
  });

  it('honours the legacy thread_ts alias when checkpoint_id is absent, and checkpoint_id when both are given', () => {
    expect(
      parseThreadConfig({ configurable: { thread_id: 't', thread_ts: 'c7' } }).address.checkpointId,
    ).toBe('c7');
    expect(
      parseThreadConfig({ configurable: { thread_id: 't', thread_ts: 'c7', checkpoint_id: 'c9' } })
        .address.checkpointId,
    ).toBe('c9');
    expect(() => parseThreadConfig({ configurable: { thread_id: 't', thread_ts: 'a#b' } })).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'thread_ts' } }),
    );
  });
});

describe('parseConfig without a thread', () => {
  it('resolves the identifiers a thread-less config gives, with an empty thread', () => {
    expect(threadless({ configurable: { checkpoint_ns: 'ns' } })).toEqual({
      threadId: '',
      checkpointNs: 'ns',
      checkpointId: undefined,
    });
  });

  it('defaults the namespace to the root one and reads the legacy id alias', () => {
    expect(threadless({ configurable: { thread_ts: 'c1' } })).toEqual({
      threadId: '',
      checkpointNs: '',
      checkpointId: 'c1',
    });
  });

  /** A falsy id means "the latest", exactly as the reference resolves it. */
  it('treats an empty checkpoint id as absent', () => {
    expect(threadless({ configurable: { checkpoint_id: '' } })).toMatchObject({
      checkpointId: undefined,
    });
  });

  /** The identifiers it does give are still parsed; that was the defect. */
  it('validates the identifiers it does carry', () => {
    expect(() => threadless({ configurable: { checkpoint_ns: 'a#b' } })).toThrow(/checkpoint_ns/);
    expect(() => threadless({ configurable: { checkpoint_id: 'a#b' } })).toThrow(/checkpoint_id/);
  });

  it('refuses a non-object config, naming it', () => {
    for (const config of NON_OBJECT_CONFIGS) {
      expect(() => threadless(config as never)).toThrow(
        expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'config' } }),
      );
    }
  });

  it('accepts a config with no configurable block at all', () => {
    expect(threadless({})).toEqual({
      threadId: '',
      checkpointNs: '',
      checkpointId: undefined,
    });
  });
});

describe('parseConfig and the thread', () => {
  it('leaves threadId undefined exactly when configurable.thread_id is absent', () => {
    expect(parseConfig({ configurable: { thread_id: 't' } }).threadId === undefined).toBe(false);
    expect(parseConfig({ configurable: {} }).threadId === undefined).toBe(true);
    expect(parseConfig({}).threadId === undefined).toBe(true);
  });

  /**
   * `get-tuple.ts` and `list.ts` both read a config that may name no thread,
   * through the same `parseConfig`, so the shape check has to live in the
   * parser: a `null`/`undefined` config is refused there before any property
   * is read off it, rather than reaching a bare `TypeError`.
   */
  it('refuses a non-object config, naming it', () => {
    for (const config of NON_OBJECT_CONFIGS) {
      expect(() => parseConfig(config as never)).toThrow(
        expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'config' } }),
      );
    }
  });
});

describe('the absence markers of a checkpoint id', () => {
  const idOf = (value: unknown) =>
    parseConfig({ configurable: { thread_id: 't', checkpoint_id: value as string } }).checkpointId;

  it('are exactly undefined, null and the empty string', () => {
    expect([undefined, null, ''].map(idOf)).toEqual([undefined, undefined, undefined]);
    expect(idOf('c1')).toBe('c1');
    for (const value of [0, false, Number.NaN, ' ']) {
      expect(() => idOf(value)).toThrow(
        expect.objectContaining({
          code: ErrorCode.VALIDATION,
          context: { field: 'checkpoint_id' },
        }),
      );
    }
  });
});

describe('the config shape parseDeltaHistoryRequest checks', () => {
  const refusal = (field: string) =>
    expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field } });

  it('accepts a config with or without configurable and signal', () => {
    expect(() => parseDeltaHistoryRequest({ config: {}, channels: [] })).not.toThrow();
    const signal = new AbortController().signal;
    expect(() =>
      parseDeltaHistoryRequest({
        config: { configurable: { thread_id: 't' }, signal },
        channels: [],
      }),
    ).not.toThrow();
  });

  it('names config, then configurable, then signal', () => {
    expect(() => parseDeltaHistoryRequest({ config: null as never, channels: [] })).toThrow(
      refusal('config'),
    );
    expect(() =>
      parseDeltaHistoryRequest({
        config: { configurable: 'x', signal: {} } as never,
        channels: [],
      }),
    ).toThrow(refusal('configurable'));
    expect(() =>
      parseDeltaHistoryRequest({ config: { configurable: null } as never, channels: [] }),
    ).toThrow(refusal('configurable'));
    expect(() =>
      parseDeltaHistoryRequest({ config: { signal: {} } as never, channels: [] }),
    ).toThrow(refusal('signal'));
  });
});
