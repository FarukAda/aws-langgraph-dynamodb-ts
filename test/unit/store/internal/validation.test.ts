import { ValidationError } from '../../../../src/shared/errors/errors';
import {
  validateKey,
  validateNamespace,
  validatePaging,
  validateStoreKey,
} from '../../../../src/store/internal/validation';

describe('validateNamespace', () => {
  it('accepts a non-empty, separator-free namespace', () => {
    expect(() => validateNamespace(['users', 'u1'])).not.toThrow();
  });

  it('throws on an empty namespace array', () => {
    expect(() => validateNamespace([])).toThrow(ValidationError);
  });

  it('throws on an empty namespace element', () => {
    expect(() => validateNamespace(['users', ''])).toThrow(ValidationError);
  });

  it('throws when an element contains the reserved separator', () => {
    expect(() => validateNamespace(['users', 'a#b'])).toThrow(ValidationError);
  });

  it('throws when an element contains a control character (M7)', () => {
    expect(() => validateNamespace(['users', 'a\u001b[31m'])).toThrow(/control characters/);
  });
});

describe('validateKey', () => {
  it('accepts a non-empty, separator-free key', () => {
    expect(() => validateKey('k1')).not.toThrow();
  });

  it('throws on an empty key', () => {
    expect(() => validateKey('')).toThrow(ValidationError);
  });

  it('throws when the key contains the reserved separator', () => {
    expect(() => validateKey('b#c')).toThrow(ValidationError);
  });

  it('throws when the key contains a control character (M7)', () => {
    expect(() => validateKey('b\u0000c')).toThrow(/control characters/);
  });
});

describe('validateStoreKey (STORE-14)', () => {
  it('bounds each segment at 256 bytes', () => {
    expect(() => validateStoreKey(['users', 'u1'], 'k'.repeat(256))).not.toThrow();
    expect(() => validateStoreKey(['users', 'u1'], 'k'.repeat(257))).toThrow(
      'key must be at most 256 bytes',
    );
    expect(() => validateNamespace(['users', 'e'.repeat(257)])).toThrow(
      'namespace element must be at most 256 bytes',
    );
  });

  it('bounds the composed sort key at the 1024 bytes DynamoDB allows', () => {
    const rest = ['a'.repeat(256), 'b'.repeat(256), 'c'.repeat(256)];
    expect(() => validateStoreKey(['root', ...rest], 'k'.repeat(253))).not.toThrow();
    expect(() => validateStoreKey(['root', ...rest], 'k'.repeat(254))).toThrow(
      /1025-byte sort key.*1024 bytes/,
    );
  });

  it('rejects a whitespace-only element or key', () => {
    expect(() => validateNamespace(['users', '  '])).toThrow(ValidationError);
    expect(() => validateKey(' ')).toThrow(ValidationError);
  });
});

describe('validatePaging', () => {
  it('accepts non-negative integers', () => {
    expect(() => validatePaging(0, 10)).not.toThrow();
  });

  it('throws on a negative offset', () => {
    expect(() => validatePaging(-1, 10)).toThrow(ValidationError);
  });

  it('throws on a non-integer limit', () => {
    expect(() => validatePaging(0, 1.5)).toThrow(ValidationError);
  });
});
