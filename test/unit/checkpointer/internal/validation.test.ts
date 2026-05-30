import {
  validateCheckpointId,
  validateCheckpointNs,
  validateTaskId,
  validateThreadId,
} from '../../../../src/checkpointer/internal/validation';
import { ErrorCode } from '../../../../src/shared/errors/error-code';

function expectValidationError(fn: () => void): void {
  try {
    fn();
    throw new Error('should have thrown');
  } catch (error) {
    expect((error as { code: ErrorCode }).code).toBe(ErrorCode.VALIDATION);
  }
}

describe('checkpointer validation', () => {
  it('accepts separator-free identifiers', () => {
    expect(() => validateThreadId('thread-1')).not.toThrow();
    expect(() => validateCheckpointNs('')).not.toThrow();
    expect(() => validateCheckpointNs('a|b')).not.toThrow();
    expect(() => validateCheckpointId('ckpt-1')).not.toThrow();
    expect(() => validateTaskId('task-1')).not.toThrow();
  });

  it('rejects a reserved separator in any segment', () => {
    expectValidationError(() => validateThreadId('thread#1'));
    expectValidationError(() => validateCheckpointNs('ns#x'));
    expectValidationError(() => validateCheckpointId('ckpt#1'));
    expectValidationError(() => validateTaskId('task#1'));
  });

  it('rejects empty thread/checkpoint/task ids', () => {
    expectValidationError(() => validateThreadId(''));
    expectValidationError(() => validateCheckpointId(''));
    expectValidationError(() => validateTaskId(''));
  });
});
