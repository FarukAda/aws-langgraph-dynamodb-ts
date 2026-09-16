import { ErrorCode } from '../../../../src/shared/errors/error-code';
import {
  assertBaseCollaborators,
  assertMembers,
  assertSignalLike,
  CLIENT_MEMBERS,
  EMBEDDINGS_MEMBERS,
  isAbortSignalLike,
  LOGGER_MEMBERS,
  SERDE_MEMBERS,
  VECTOR_BACKEND_MEMBERS,
} from '../../../../src/shared/validation/collaborators';

describe('assertMembers', () => {
  it('accepts a value exposing every named member as a function', () => {
    expect(() => assertMembers({ a: () => {}, b: () => {} }, ['a', 'b'], 'thing')).not.toThrow();
  });

  it('refuses a non-object value, naming the field alone', () => {
    for (const value of ['x', 7, true]) {
      try {
        assertMembers(value as never, ['a'], 'thing');
        throw new Error('should have thrown');
      } catch (error) {
        const typed = error as { code: ErrorCode; context: { field?: string } };
        expect(typed.code).toBe(ErrorCode.VALIDATION);
        expect(typed.context.field).toBe('thing');
      }
    }
  });

  it('refuses null, naming the field alone', () => {
    expect(() => assertMembers(null as never, ['a'], 'thing')).toThrow(
      expect.objectContaining({ context: { field: 'thing' } }),
    );
  });

  it('names the first missing member, dotted under the field', () => {
    expect(() => assertMembers({ a: () => {} }, ['a', 'b'], 'thing')).toThrow(
      expect.objectContaining({ context: { field: 'thing.b' } }),
    );
  });

  it('refuses a member that is present but not callable, same as one absent', () => {
    expect(() => assertMembers({ a: 1 }, ['a'], 'thing')).toThrow(
      expect.objectContaining({ context: { field: 'thing.a' } }),
    );
  });
});

describe('assertBaseCollaborators', () => {
  it('leaves every collaborator unchecked when none was supplied', () => {
    expect(() => assertBaseCollaborators({})).not.toThrow();
  });

  it('checks an injected client only when one was supplied', () => {
    const complete = {
      get() {},
      put() {},
      delete() {},
      update() {},
      query() {},
      scan() {},
      batchWrite() {},
      transactWrite() {},
    };
    expect(() => assertBaseCollaborators({ client: complete })).not.toThrow();
    expect(() => assertBaseCollaborators({ client: {} })).toThrow(
      expect.objectContaining({ code: 'VALIDATION', context: { field: 'client.get' } }),
    );
  });

  it('checks an injected logger only when one was supplied', () => {
    const complete = { debug() {}, info() {}, warn() {}, error() {} };
    expect(() => assertBaseCollaborators({ logger: complete })).not.toThrow();
    expect(() => assertBaseCollaborators({ logger: {} })).toThrow(
      expect.objectContaining({ code: 'VALIDATION', context: { field: 'logger.debug' } }),
    );
  });

  it('checks an injected serde only when one was supplied', () => {
    const complete = { dumpsTyped() {}, loadsTyped() {} };
    expect(() => assertBaseCollaborators({ serde: complete })).not.toThrow();
    expect(() => assertBaseCollaborators({ serde: {} })).toThrow(
      expect.objectContaining({ code: 'VALIDATION', context: { field: 'serde.dumpsTyped' } }),
    );
  });
});

describe('the member lists, verified against src/ (see the task brief)', () => {
  it('lists exactly what each collaborator is called with', () => {
    expect(CLIENT_MEMBERS).toEqual([
      'get',
      'put',
      'delete',
      'update',
      'query',
      'scan',
      'batchWrite',
      'transactWrite',
    ]);
    expect(LOGGER_MEMBERS).toEqual(['debug', 'info', 'warn', 'error']);
    expect(SERDE_MEMBERS).toEqual(['dumpsTyped', 'loadsTyped']);
    expect(EMBEDDINGS_MEMBERS).toEqual(['embedQuery', 'embedDocuments']);
  });

  /** `listKeys` is optional on the interface and reconcile already handles its absence, so it must not be required. */
  it('does not require vectorBackend.listKeys', () => {
    expect(VECTOR_BACKEND_MEMBERS).toEqual(['upsert', 'query', 'delete']);
  });
});

describe('isAbortSignalLike', () => {
  it('is false for a non-object value, including undefined', () => {
    expect(isAbortSignalLike(undefined)).toBe(false);
    expect(isAbortSignalLike('x' as never)).toBe(false);
  });

  it('is false for null', () => {
    expect(isAbortSignalLike(null as never)).toBe(false);
  });

  it('is false when aborted is not a boolean', () => {
    expect(isAbortSignalLike({ aborted: 'no', addEventListener: () => {} } as never)).toBe(false);
  });

  it('is false when addEventListener is not callable', () => {
    expect(isAbortSignalLike({ aborted: false, addEventListener: 1 } as never)).toBe(false);
  });

  it('is true for a real AbortSignal, and for a structurally equivalent double', () => {
    expect(isAbortSignalLike(new AbortController().signal)).toBe(true);
    expect(isAbortSignalLike({ aborted: false, addEventListener: () => {} } as never)).toBe(true);
  });
});

describe('assertSignalLike', () => {
  it('leaves an absent signal unchecked', () => {
    expect(() => assertSignalLike(undefined)).not.toThrow();
  });

  it('accepts a real AbortSignal', () => {
    expect(() => assertSignalLike(new AbortController().signal)).not.toThrow();
  });

  it('refuses a value that is not AbortSignal-like, naming `signal`', () => {
    expect(() => assertSignalLike({} as never)).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'signal' } }),
    );
  });
});
