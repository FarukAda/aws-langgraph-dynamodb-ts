import { toError } from '../../../../src/shared/errors/wrap-error';

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
