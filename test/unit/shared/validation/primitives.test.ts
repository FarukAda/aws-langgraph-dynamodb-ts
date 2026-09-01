import { ErrorCode } from '../../../../src/shared/errors/error-code';
import {
  assertMaxBytes,
  assertNoControlChars,
  assertNoSeparator,
  validateIdentifier,
  validateInteger,
  validateNonEmptyArray,
  validateNonEmptyString,
} from '../../../../src/shared/validation/primitives';

describe('validateNonEmptyString', () => {
  it('accepts a non-empty string', () => {
    expect(() => validateNonEmptyString('ok', 'threadId')).not.toThrow();
  });

  it('rejects empty / non-string with a VALIDATION error naming the field', () => {
    expect(() => validateNonEmptyString('', 'threadId')).toThrow(/threadId/);
    try {
      validateNonEmptyString('', 'threadId');
    } catch (error) {
      expect((error as { code: ErrorCode }).code).toBe(ErrorCode.VALIDATION);
    }
  });

  it('rejects a whitespace-only string (SEC-10)', () => {
    expect(() => validateNonEmptyString('   ', 'threadId')).toThrow(/threadId/);
    expect(() => validateNonEmptyString(String.fromCharCode(9, 10), 'threadId')).toThrow(
      /threadId/,
    );
  });
});

describe('assertMaxBytes', () => {
  it('measures UTF-8 bytes, not UTF-16 code units', () => {
    const accented = 'é'.repeat(3);
    expect(() => assertMaxBytes(accented, 'key', 6)).not.toThrow();
    expect(() => assertMaxBytes(accented, 'key', 5)).toThrow('key must be at most 5 bytes');
  });
});

describe('validateIdentifier', () => {
  it('bounds the identifier length in bytes', () => {
    expect(() => validateIdentifier('a'.repeat(8), '#', 'id', 8)).not.toThrow();
    expect(() => validateIdentifier('a'.repeat(9), '#', 'id', 8)).toThrow(
      'id must be at most 8 bytes',
    );
  });
});

describe('validateInteger', () => {
  it('enforces integer and bounds', () => {
    expect(() => validateInteger(5, 'ttl', { min: 1, max: 10 })).not.toThrow();
    expect(() => validateInteger(1.5, 'ttl')).toThrow(/integer/);
    expect(() => validateInteger(0, 'ttl', { min: 1 })).toThrow(/ttl/);
    expect(() => validateInteger(11, 'ttl', { max: 10 })).toThrow(/ttl/);
  });

  it('accepts a valid integer when no bounds are supplied', () => {
    expect(() => validateInteger(42, 'count')).not.toThrow();
  });
});

describe('validateNonEmptyArray', () => {
  it('accepts a non-empty array', () => {
    expect(() => validateNonEmptyArray(['a'], 'namespace')).not.toThrow();
  });

  it('rejects an empty array naming the field', () => {
    expect(() => validateNonEmptyArray([], 'namespace')).toThrow(/namespace/);
  });
});

describe('assertNoControlChars', () => {
  it('rejects control characters', () => {
    expect(() => assertNoControlChars('a\u0001b', 'key')).toThrow(/control/);
    expect(() => assertNoControlChars('a\u007fb', 'key')).toThrow(/control/);
    expect(() => assertNoControlChars('clean', 'key')).not.toThrow();
  });
});

describe('assertNoSeparator', () => {
  it('rejects the reserved separator', () => {
    expect(() => assertNoSeparator('a#b', '#', 'namespace')).toThrow(/namespace/);
    expect(() => assertNoSeparator('ab', '#', 'namespace')).not.toThrow();
  });
});
