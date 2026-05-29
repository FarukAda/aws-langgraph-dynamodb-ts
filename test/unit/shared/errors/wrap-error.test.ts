import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { ValidationError } from '../../../../src/shared/errors/errors';
import { toError, wrapError } from '../../../../src/shared/errors/wrap-error';

describe('wrapError', () => {
  it('wraps a raw error into a coded library error preserving the cause', () => {
    const raw = new Error('aws blew up');
    const wrapped = wrapError(raw, ErrorCode.S3_OFFLOAD_FAILED, { operation: 'upload' });
    expect(wrapped.code).toBe(ErrorCode.S3_OFFLOAD_FAILED);
    expect(wrapped.message).toBe('aws blew up');
    expect(wrapped.context).toEqual({ operation: 'upload' });
    expect(wrapped.cause).toBe(raw);
  });

  it('does not double-wrap an already-coded error', () => {
    const already = new ValidationError('bad');
    expect(wrapError(already, ErrorCode.NOT_FOUND)).toBe(already);
  });

  it('defaults the context to an empty object when none is given', () => {
    const wrapped = wrapError(new Error('boom'), ErrorCode.RETRY_EXHAUSTED);
    expect(wrapped.context).toEqual({});
  });
});

describe('toError', () => {
  it('passes through Error-shaped values', () => {
    const e = new Error('x');
    expect(toError(e)).toBe(e);
  });

  it('coerces a non-Error string value to an Error', () => {
    expect(toError('oops' as unknown as Error).message).toBe('oops');
  });

  it('JSON-stringifies a non-Error, non-string value', () => {
    expect(toError({ reason: 'nope' } as unknown as Error).message).toBe('{"reason":"nope"}');
  });
});
