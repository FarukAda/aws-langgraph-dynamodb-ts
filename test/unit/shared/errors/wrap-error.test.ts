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
});

describe('toError', () => {
  it('passes through Error-shaped values', () => {
    const e = new Error('x');
    expect(toError(e)).toBe(e);
  });

  it('coerces a non-Error value to an Error', () => {
    expect(toError('oops' as unknown as Error).message).toBe('oops');
  });
});
