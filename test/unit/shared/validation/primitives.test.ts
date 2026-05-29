import { ErrorCode } from '../../../../src/shared/errors/error-code';
import {
  assertNoControlChars,
  assertNoSeparator,
  validateArrayMaxDepth,
  validateInteger,
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

describe('validateArrayMaxDepth', () => {
  it('rejects nesting beyond the max depth', () => {
    expect(() => validateArrayMaxDepth([[[1]]], 'v', 2)).toThrow(/depth/);
    expect(() => validateArrayMaxDepth([[1]], 'v', 2)).not.toThrow();
  });

  it('accepts arrays exactly at the max depth', () => {
    expect(() => validateArrayMaxDepth([[1]], 'v', 2)).not.toThrow();
  });

  it('short-circuits and rejects arrays nested well beyond the max depth', () => {
    expect(() => validateArrayMaxDepth([[[[1]]]], 'v', 2)).toThrow(/depth/);
  });
});
