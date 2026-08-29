import { validateSessionId } from '../../../../src/history/internal/validation';
import { ErrorCode } from '../../../../src/shared/errors/error-code';

function expectValidationError(fn: () => void): void {
  try {
    fn();
    throw new Error('should have thrown');
  } catch (error) {
    expect((error as { code: ErrorCode }).code).toBe(ErrorCode.VALIDATION);
  }
}

describe('validateSessionId', () => {
  it('accepts an ordinary session id', () => {
    expect(() => validateSessionId('session-1')).not.toThrow();
  });

  it('rejects an empty or non-string session id', () => {
    expectValidationError(() => validateSessionId(''));
    expectValidationError(() => validateSessionId(null as never));
  });

  it('rejects the reserved separator (M12)', () => {
    expectValidationError(() => validateSessionId('a#b'));
  });

  it('rejects control characters (M7)', () => {
    expectValidationError(() => validateSessionId('s\u001b[31m'));
  });
});
