import { ErrorCode } from '../../../../src/shared/errors/error-code';

/**
 * `ErrorCode` is exported from the package root, so every consumer in a
 * process shares one object. A single dependency assigning to a member
 * rewrites what `error.code === ErrorCode.X` means for every other consumer,
 * and nothing is raised anywhere: the branch simply stops matching.
 */
describe('ErrorCode', () => {
  it('is frozen, so no consumer can rewrite a member for every other consumer', () => {
    expect(Object.isFrozen(ErrorCode)).toBe(true);
  });

  it('refuses an assignment instead of silently taking it', () => {
    const mutable = ErrorCode as unknown as { VALIDATION: string };
    expect(() => {
      mutable.VALIDATION = 'x';
    }).toThrow(TypeError);
    expect(ErrorCode.VALIDATION).toBe('VALIDATION');
  });
});
