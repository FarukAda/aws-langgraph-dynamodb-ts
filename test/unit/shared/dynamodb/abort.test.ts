import { abortErrorFrom, isAbortError } from '../../../../src/shared/dynamodb/abort';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { abortError, validationError } from '../../../../src/shared/errors/errors';

describe('abortErrorFrom', () => {
  it('wraps the DOMException a bare abort() produces as the cause of a library ABORTED error', () => {
    const controller = new AbortController();
    controller.abort();
    const error = abortErrorFrom(controller.signal);
    expect(error).toMatchObject({ name: 'DynamoDBLangGraphError', code: ErrorCode.ABORTED });
    expect((error.cause as Error).name).toBe('AbortError');
  });

  it('returns a library ABORTED error given as the reason unchanged', () => {
    const reason = abortError('caller cancelled');
    const controller = new AbortController();
    controller.abort(reason);
    expect(abortErrorFrom(controller.signal)).toBe(reason);
  });

  /**
   * Not a bug, unlike the two S3 sharing points: a reason the caller shares
   * across more than one call's signal is one object by the caller's own
   * choice, not something this library caches, and returning it unchanged
   * rather than a copy is what keeps a reason from accumulating wrappers
   * across layers. Whichever call's boundary reaches it first is the one its
   * `context.operation` reports — documented in `stampContext`'s own JSDoc
   * and in the README where `operation` is defined.
   */
  it('lets two calls sharing one reason see whichever boundary stamped it first', () => {
    const reason = abortError('shutting down');
    const controller = new AbortController();
    controller.abort(reason);
    const first = abortErrorFrom(controller.signal);
    const second = abortErrorFrom(controller.signal);
    expect(first).toBe(second);
    expect(first).toBe(reason);
    first.context.operation = 'saver.put';
    expect(second.context.operation).toBe('saver.put');
  });

  it('turns a non-Error reason into the cause and tolerates a missing reason', () => {
    const controller = new AbortController();
    controller.abort('shutting down');
    expect((abortErrorFrom(controller.signal).cause as Error).message).toBe('shutting down');
    const reasonless = { aborted: true, reason: undefined } as unknown as AbortSignal;
    expect(abortErrorFrom(reasonless).cause).toBeUndefined();
  });
});

describe('isAbortError', () => {
  /**
   * The question every wrapper asks before it rebrands a failure: is this the
   * caller's own stop? It is answered on the code alone, because that is the
   * only thing a caller branches on and the only thing that survives a second
   * copy of this package in the same process.
   */
  it('recognises a cancel by its code, whatever produced it', () => {
    const controller = new AbortController();
    controller.abort();
    expect(isAbortError(abortErrorFrom(controller.signal))).toBe(true);
    expect(isAbortError(abortError('cancelled'))).toBe(true);
  });

  it('says no to every other error, branded or not', () => {
    expect(isAbortError(validationError('bad', 'field'))).toBe(false);
    expect(isAbortError(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe(false);
    expect(isAbortError(new Error('plain'))).toBe(false);
    // The brand is required: an unbranded object that merely carries the
    // code looks like a cancel and is not one.
    expect(isAbortError(Object.assign(new Error('x'), { code: ErrorCode.ABORTED }))).toBe(false);
  });

  it('answers false for an absent reason, which a signal aborted without one can carry', () => {
    expect(isAbortError(undefined)).toBe(false);
  });
});
