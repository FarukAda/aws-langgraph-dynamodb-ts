import { ValidationError } from '../../../../src/shared/errors/errors';
import {
  validateKey,
  validateNamespace,
  validatePaging,
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
