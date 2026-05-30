import { readConfigurable } from '../../../../src/checkpointer/internal/configurable';
import { ErrorCode } from '../../../../src/shared/errors/error-code';

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
