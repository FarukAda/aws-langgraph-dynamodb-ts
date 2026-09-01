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

  it('rejects control characters in any identifier (M7)', () => {
    // An unvalidated ANSI escape in an id is a log/terminal-injection surface
    // for any consuming app that writes these values to a raw log.
    expectValidationError(() => validateThreadId('thread\u001b[31m'));
    expectValidationError(() => validateCheckpointNs('ns\u0000'));
    expectValidationError(() => validateCheckpointId('ckpt\u0007'));
    expectValidationError(() => validateTaskId('task\u007f'));
  });

  it('bounds thread_id at 1024 bytes and every sort-key segment at 256 bytes (SEC-10)', () => {
    expect(() => validateThreadId('t'.repeat(1024))).not.toThrow();
    expectValidationError(() => validateThreadId('t'.repeat(1025)));
    expect(() => validateCheckpointNs('n'.repeat(256))).not.toThrow();
    expectValidationError(() => validateCheckpointNs('n'.repeat(257)));
    expect(() => validateCheckpointId('c'.repeat(256))).not.toThrow();
    expectValidationError(() => validateCheckpointId('c'.repeat(257)));
    expect(() => validateTaskId('k'.repeat(256))).not.toThrow();
    expectValidationError(() => validateTaskId('k'.repeat(257)));
  });

  it('rejects whitespace-only ids', () => {
    expectValidationError(() => validateThreadId('   '));
    expectValidationError(() => validateCheckpointId(' '));
    expectValidationError(() => validateTaskId(String.fromCharCode(9)));
  });

  it('still accepts an empty checkpoint namespace, the root namespace (M7)', () => {
    expect(() => validateCheckpointNs('')).not.toThrow();
  });
});
