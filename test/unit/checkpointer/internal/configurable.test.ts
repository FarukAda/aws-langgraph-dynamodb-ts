import {
  isThreadless,
  readConfigurable,
  readThreadlessConfigurable,
} from '../../../../src/checkpointer/internal/configurable';
import { ErrorCode } from '../../../../src/shared/errors/error-code';

/** Every reader below refuses the same non-object configs the same way. */
const NON_OBJECT_CONFIGS = [null, undefined, 'x', 1, []];

describe('readConfigurable', () => {
  it('extracts thread id, defaulting namespace to empty and id to undefined', () => {
    expect(readConfigurable({ configurable: { thread_id: 't1' } })).toEqual({
      threadId: 't1',
      checkpointNs: '',
      checkpointId: undefined,
    });
  });

  it('passes through namespace and checkpoint id when present', () => {
    expect(
      readConfigurable({
        configurable: { thread_id: 't1', checkpoint_ns: 'inner', checkpoint_id: 'c9' },
      }),
    ).toEqual({ threadId: 't1', checkpointNs: 'inner', checkpointId: 'c9' });
  });

  it('throws a VALIDATION error when thread_id is missing', () => {
    try {
      readConfigurable({ configurable: {} });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code: ErrorCode }).code).toBe(ErrorCode.VALIDATION);
    }
  });

  it('throws when configurable is absent entirely', () => {
    expect(() => readConfigurable({})).toThrow(/thread_id/);
  });

  /**
   * `config.configurable` used to be read straight off the argument, so a
   * `null` or `undefined` config reached a bare `TypeError` from that
   * property access instead of naming the caller's mistake.
   */
  it('refuses a non-object config, naming it', () => {
    for (const config of NON_OBJECT_CONFIGS) {
      expect(() => readConfigurable(config as never)).toThrow(
        expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'config' } }),
      );
    }
  });

  it('throws a VALIDATION error when an id contains the reserved separator', () => {
    expect(() => readConfigurable({ configurable: { thread_id: 'a#b' } })).toThrow();
    expect(() =>
      readConfigurable({ configurable: { thread_id: 't', checkpoint_ns: 'n#s' } }),
    ).toThrow();
    expect(() =>
      readConfigurable({ configurable: { thread_id: 't', checkpoint_id: 'c#1' } }),
    ).toThrow();
  });
});

describe('readConfigurable falsy checkpoint_id (CKPT-06)', () => {
  it('treats null and the empty string as "latest" like the reference savers', () => {
    expect(
      readConfigurable({ configurable: { thread_id: 't', checkpoint_id: null as never } })
        .checkpointId,
    ).toBeUndefined();
    expect(
      readConfigurable({ configurable: { thread_id: 't', checkpoint_id: '' } }).checkpointId,
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
        readConfigurable({
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
      readConfigurable({ configurable: { thread_id: 't', thread_ts: 'c7' } }).checkpointId,
    ).toBe('c7');
    expect(
      readConfigurable({ configurable: { thread_id: 't', thread_ts: 'c7', checkpoint_id: 'c9' } })
        .checkpointId,
    ).toBe('c9');
    expect(() =>
      readConfigurable({ configurable: { thread_id: 't', thread_ts: 'a#b' } }),
    ).toThrow();
  });
});

describe('readThreadlessConfigurable', () => {
  it('resolves the identifiers a thread-less config gives, with an empty thread', () => {
    expect(readThreadlessConfigurable({ configurable: { checkpoint_ns: 'ns' } })).toEqual({
      threadId: '',
      checkpointNs: 'ns',
      checkpointId: undefined,
    });
  });

  it('defaults the namespace to the root one and reads the legacy id alias', () => {
    expect(readThreadlessConfigurable({ configurable: { thread_ts: 'c1' } })).toEqual({
      threadId: '',
      checkpointNs: '',
      checkpointId: 'c1',
    });
  });

  /** A falsy id means "the latest", exactly as the reference resolves it. */
  it('treats an empty checkpoint id as absent', () => {
    expect(readThreadlessConfigurable({ configurable: { checkpoint_id: '' } })).toMatchObject({
      checkpointId: undefined,
    });
  });

  /** The identifiers it does give are still validated; that was the defect. */
  it('validates the identifiers it does carry', () => {
    expect(() => readThreadlessConfigurable({ configurable: { checkpoint_ns: 'a#b' } })).toThrow(
      /checkpoint_ns/,
    );
    expect(() => readThreadlessConfigurable({ configurable: { checkpoint_id: 'a#b' } })).toThrow(
      /checkpoint_id/,
    );
  });

  it('refuses a non-object config, naming it', () => {
    for (const config of NON_OBJECT_CONFIGS) {
      expect(() => readThreadlessConfigurable(config as never)).toThrow(
        expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'config' } }),
      );
    }
  });

  it('accepts a config with no configurable block at all', () => {
    expect(readThreadlessConfigurable({})).toEqual({
      threadId: '',
      checkpointNs: '',
      checkpointId: undefined,
    });
  });
});

describe('isThreadless', () => {
  it('is true exactly when configurable.thread_id is absent', () => {
    expect(isThreadless({ configurable: { thread_id: 't' } })).toBe(false);
    expect(isThreadless({ configurable: {} })).toBe(true);
    expect(isThreadless({})).toBe(true);
  });

  /**
   * `get-tuple.ts` and `list-scope.ts` both read `config.configurable` to
   * choose between `readConfigurable` and `readThreadlessConfigurable`
   * before either of those runs — the shape check has to live here, or a
   * `null`/`undefined` config reaches that read as a bare `TypeError` before
   * either function gets a chance to refuse it.
   */
  it('refuses a non-object config, naming it', () => {
    for (const config of NON_OBJECT_CONFIGS) {
      expect(() => isThreadless(config as never)).toThrow(
        expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'config' } }),
      );
    }
  });
});
