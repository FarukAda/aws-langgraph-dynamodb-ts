import { ErrorCode } from '../../../../src/shared/errors/error-code';
import {
  assertMaxBytes,
  assertNoControlChars,
  assertNoSeparator,
  assertWellFormed,
  validateIdentifier,
  validateInteger,
  validateNonEmptyArray,
  validateNonEmptyString,
  validateStringArray,
} from '../../../../src/shared/validation/primitives';

/** The states a caller can reach that the declared `string` type rules out. */
const NON_STRINGS = [undefined, null, 42, true, {}, []] as never[];

const HIGH = String.fromCharCode(0xd83d);
const LOW = String.fromCharCode(0xde00);

function expectValidationError(fn: () => void, field: string): void {
  try {
    fn();
    throw new Error('expected a throw');
  } catch (error) {
    const coded = error as { code?: string; context?: { field?: string } };
    expect(coded.code).toBe(ErrorCode.VALIDATION);
    expect(coded.context?.field).toBe(field);
  }
}

describe('validateNonEmptyString', () => {
  it.each(NON_STRINGS)('rejects the non-string %p', (value) => {
    expectValidationError(() => validateNonEmptyString(value, 'threadId'), 'threadId');
  });

  it('rejects an empty string', () => {
    expectValidationError(() => validateNonEmptyString('', 'threadId'), 'threadId');
  });

  it('rejects a whitespace-only string (SEC-10)', () => {
    expectValidationError(() => validateNonEmptyString('   ', 'threadId'), 'threadId');
  });

  it('accepts a string with one non-whitespace character', () => {
    expect(() => validateNonEmptyString(' a ', 'threadId')).not.toThrow();
  });
});

describe('assertMaxBytes', () => {
  it.each(NON_STRINGS)('rejects the non-string %p', (value) => {
    expectValidationError(() => assertMaxBytes(value, 'key', 8), 'key');
  });

  it('accepts a value under the budget and one exactly at it', () => {
    expect(() => assertMaxBytes('abc', 'key', 8)).not.toThrow();
    expect(() => assertMaxBytes('abcdefgh', 'key', 8)).not.toThrow();
  });

  it('rejects a value over the budget', () => {
    expectValidationError(() => assertMaxBytes('abcdefghi', 'key', 8), 'key');
  });

  /** DynamoDB and S3 count UTF-8 bytes; a code-unit count would accept too much. */
  it('measures UTF-8 bytes, not UTF-16 code units', () => {
    expect(() => assertMaxBytes('é', 'key', 2)).not.toThrow();
    expectValidationError(() => assertMaxBytes('é', 'key', 1), 'key');
  });
});

describe('validateInteger', () => {
  it.each([undefined, null, '5', true, {}] as never[])('rejects the non-number %p', (value) => {
    expectValidationError(() => validateInteger(value, 'ttl'), 'ttl');
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %p as not an integer', (value) => {
    expect(() => validateInteger(value, 'ttl')).toThrow(/integer/);
  });

  it('accepts any integer when no bounds are given', () => {
    expect(() => validateInteger(42, 'count')).not.toThrow();
    expect(() => validateInteger(-7, 'count')).not.toThrow();
    expect(() => validateInteger(0, 'count', {})).not.toThrow();
  });

  it('treats min as inclusive', () => {
    expect(() => validateInteger(1, 'ttl', { min: 1 })).not.toThrow();
    expect(() => validateInteger(0, 'ttl', { min: 1 })).toThrow(/>= 1/);
  });

  it('treats max as inclusive', () => {
    expect(() => validateInteger(10, 'ttl', { max: 10 })).not.toThrow();
    expect(() => validateInteger(11, 'ttl', { max: 10 })).toThrow(/<= 10/);
  });

  it('applies both bounds when both are given', () => {
    expect(() => validateInteger(5, 'ttl', { min: 1, max: 10 })).not.toThrow();
    expect(() => validateInteger(0, 'ttl', { min: 1, max: 10 })).toThrow(/>= 1/);
    expect(() => validateInteger(11, 'ttl', { min: 1, max: 10 })).toThrow(/<= 10/);
  });

  it('reports the integer rule before either bound', () => {
    expect(() => validateInteger(0.5, 'ttl', { min: 1 })).toThrow(/integer/);
  });
});

describe('validateNonEmptyArray', () => {
  it.each([undefined, null, 'abc', 42, {}] as never[])('rejects the non-array %p', (value) => {
    expectValidationError(() => validateNonEmptyArray(value, 'namespace'), 'namespace');
  });

  it('rejects an empty array', () => {
    expectValidationError(() => validateNonEmptyArray([], 'namespace'), 'namespace');
  });

  it('accepts a non-empty array without inspecting its elements', () => {
    expect(() => validateNonEmptyArray([''], 'namespace')).not.toThrow();
  });
});

describe('validateStringArray', () => {
  it.each([undefined, null, 'abc', 42, {}] as never[])('rejects the non-array %p', (value) => {
    expectValidationError(() => validateStringArray(value, 'channels'), 'channels');
  });

  it('rejects an array holding a non-string element', () => {
    expectValidationError(() => validateStringArray(['a', 1 as never], 'channels'), 'channels');
  });

  it('accepts an empty array and an array of strings', () => {
    expect(() => validateStringArray([], 'channels')).not.toThrow();
    expect(() => validateStringArray(['a', 'b'], 'channels')).not.toThrow();
  });
});

describe('assertNoControlChars', () => {
  it.each(NON_STRINGS)('rejects the non-string %p', (value) => {
    expectValidationError(() => assertNoControlChars(value, 'key'), 'key');
  });

  it.each([
    ['a C0 control', 'a\u0001b'],
    ['ESC, which opens a terminal escape sequence', 'a\u001bb'],
    ['DEL', 'a\u007fb'],
    ['a C1 control', 'a\u0085b'],
    ['single-byte CSI', 'a\u009bb'],
  ])('rejects %s', (_name, value) => {
    expectValidationError(() => assertNoControlChars(value, 'key'), 'key');
  });

  it('accepts printable text, including non-ASCII above the C1 range', () => {
    expect(() => assertNoControlChars('clean', 'key')).not.toThrow();
    expect(() => assertNoControlChars('naïve 日本語  ', 'key')).not.toThrow();
  });
});

describe('assertNoSeparator', () => {
  it.each(NON_STRINGS)('rejects the non-string %p', (value) => {
    expectValidationError(() => assertNoSeparator(value, '#', 'namespace'), 'namespace');
  });

  it('rejects a value containing the separator', () => {
    expectValidationError(() => assertNoSeparator('a#b', '#', 'namespace'), 'namespace');
  });

  it('accepts a value without it', () => {
    expect(() => assertNoSeparator('ab', '#', 'namespace')).not.toThrow();
  });
});

describe('assertWellFormed', () => {
  it.each(NON_STRINGS)('rejects the non-string %p', (value) => {
    expectValidationError(() => assertWellFormed(value, 'thread_id'), 'thread_id');
  });

  it.each([
    ['a trailing lone high surrogate', `a${HIGH}`],
    ['a leading lone low surrogate', `${LOW}b`],
    ['two high surrogates in a row', `${HIGH}${HIGH}`],
  ])('rejects %s', (_name, value) => {
    expectValidationError(() => assertWellFormed(value, 'thread_id'), 'thread_id');
  });

  it('accepts plain text, a complete surrogate pair and the empty string', () => {
    expect(() => assertWellFormed('plain', 'thread_id')).not.toThrow();
    expect(() => assertWellFormed(`a${HIGH}${LOW}b`, 'thread_id')).not.toThrow();
    expect(() => assertWellFormed('', 'checkpoint_ns')).not.toThrow();
  });

  /** The guarantee: an accepted value's UTF-8 encoding is injective. */
  it('round-trips every accepted value through UTF-8 unchanged', () => {
    for (const value of ['a', 'thread-1', `a${HIGH}${LOW}b`, 'naïve', '日本語', 'x'.repeat(64)]) {
      expect(() => assertWellFormed(value, 'v')).not.toThrow();
      expect(Buffer.from(value, 'utf8').toString('utf8')).toBe(value);
    }
  });
});

describe('validateIdentifier', () => {
  it('accepts a value satisfying every rule', () => {
    expect(() => validateIdentifier('thread-1', '#', 'thread_id', 1024)).not.toThrow();
  });

  /**
   * The order is contract, not implementation detail: a caller branches on
   * which rule failed, so each boundary is pinned where two rules are broken
   * at once.
   */
  it.each([
    ['string before non-blank', 42 as never, 1024, /must be a string/],
    ['non-blank before length', '', 1, /non-empty string/],
    ['length before separator', `${'x'.repeat(64)}#`, 8, /bytes of UTF-8/],
    ['separator before control chars', 'a#\u0001', 1024, /separator/],
    ['control chars before well-formedness', `\u0001${HIGH}`, 1024, /control characters/],
  ])('reports %s', (_name, value, maxBytes, message) => {
    expect(() => validateIdentifier(value, '#', 'thread_id', maxBytes)).toThrow(message);
  });

  it('rejects an ill-formed identifier that breaks no other rule', () => {
    expectValidationError(
      () => validateIdentifier(`tenant${HIGH}`, '#', 'thread_id', 1024),
      'thread_id',
    );
  });

  /** Two identifiers that encode to one key must not both be accepted. */
  it('rejects the one of two identifiers that would share an encoded key', () => {
    const lossy = `tenant${HIGH}`;
    const replacement = 'tenant�';
    expect(Buffer.from(lossy, 'utf8').toString('base64url')).toBe(
      Buffer.from(replacement, 'utf8').toString('base64url'),
    );
    expect(() => validateIdentifier(lossy, '#', 'thread_id', 1024)).toThrow();
    expect(() => validateIdentifier(replacement, '#', 'thread_id', 1024)).not.toThrow();
  });
});
