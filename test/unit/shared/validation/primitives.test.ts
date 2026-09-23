import { expectTypeOf } from 'expect-type';

import { MAX_PAGE_LIMIT } from '../../../../src/shared/constants';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import {
  assertNoControlChars,
  assertWellFormed,
  parseIdentifier,
  parseInteger,
  parseKeySegment,
  parseLimit,
  parseString,
  parseStringArray,
  type PageLimit,
  assertInteger,
  assertNonEmptyString,
  assertStringArray,
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

describe('assertNonEmptyString', () => {
  it.each(NON_STRINGS)('rejects the non-string %p', (value) => {
    expectValidationError(() => assertNonEmptyString(value, 'threadId'), 'threadId');
  });

  it('rejects an empty string', () => {
    expectValidationError(() => assertNonEmptyString('', 'threadId'), 'threadId');
  });

  it('rejects a whitespace-only string (SEC-10)', () => {
    expectValidationError(() => assertNonEmptyString('   ', 'threadId'), 'threadId');
  });

  it('accepts a string with one non-whitespace character', () => {
    expect(() => assertNonEmptyString(' a ', 'threadId')).not.toThrow();
  });
});

describe('parseKeySegment', () => {
  it.each(NON_STRINGS)('rejects the non-string %p', (value) => {
    expectValidationError(() => parseKeySegment(value, '#', 'key', 8), 'key');
  });

  it('accepts a value under the budget and one exactly at it', () => {
    expect(() => parseKeySegment('abc', '#', 'key', 8)).not.toThrow();
    expect(() => parseKeySegment('abcdefgh', '#', 'key', 8)).not.toThrow();
  });

  it('rejects a value over the budget', () => {
    expectValidationError(() => parseKeySegment('abcdefghi', '#', 'key', 8), 'key');
  });

  /** DynamoDB and S3 count UTF-8 bytes; a code-unit count would accept too much. */
  it('measures UTF-8 bytes, not UTF-16 code units', () => {
    expect(() => parseKeySegment('é', '#', 'key', 2)).not.toThrow();
    expectValidationError(() => parseKeySegment('é', '#', 'key', 1), 'key');
  });
});

/**
 * The one rule every `limit` now follows. Before it they disagreed three ways —
 * `saver.list` had no minimum at all, the history reads refused `0` and the
 * store accepted it — and none of them had a ceiling, so `limit: 1e12` resolved
 * on five public methods. One validator, one wording and one ceiling remain,
 * with two floors, because an empty listing and an empty conversation are not
 * the same answer.
 */
describe('parseLimit', () => {
  it.each([0, 1, MAX_PAGE_LIMIT])('accepts %p at the page floor', (value) => {
    expect(() => parseLimit(value, 0)).not.toThrow();
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '5' as never, null as never])(
    'refuses %p, naming limit',
    (value) => {
      expectValidationError(() => parseLimit(value, 0), 'limit');
    },
  );

  /**
   * The second floor, and the only call site that passes it is the
   * conversation window. Everything else about the rule — the wording, the
   * ceiling, the integer test — is shared, so the two differ in one number and
   * nothing else.
   */
  it('refuses zero at the window floor while the ceiling and the wording hold', () => {
    expectValidationError(() => parseLimit(0, 1), 'limit');
    expect(() => parseLimit(1, 1)).not.toThrow();
    expect(() => parseLimit(0, 1)).toThrow('limit must be >= 1');
    expect(() => parseLimit(MAX_PAGE_LIMIT + 1, 1)).toThrow(`limit must be <= ${MAX_PAGE_LIMIT}`);
  });

  /** Being told the ceiling exists is no use without being told what it is. */
  it('names the ceiling when it refuses a limit above it', () => {
    expect(() => parseLimit(MAX_PAGE_LIMIT + 1, 0)).toThrow(`limit must be <= ${MAX_PAGE_LIMIT}`);
    expect(() => parseLimit(1e12, 0)).toThrow(`limit must be <= ${MAX_PAGE_LIMIT}`);
  });
});

describe('assertInteger', () => {
  it.each([undefined, null, '5', true, {}] as never[])('rejects the non-number %p', (value) => {
    expectValidationError(() => assertInteger(value, 'ttl'), 'ttl');
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects %p as not an integer', (value) => {
    expect(() => assertInteger(value, 'ttl')).toThrow(/integer/);
  });

  it('accepts any integer when no bounds are given', () => {
    expect(() => assertInteger(42, 'count')).not.toThrow();
    expect(() => assertInteger(-7, 'count')).not.toThrow();
    expect(() => assertInteger(0, 'count', {})).not.toThrow();
  });

  it('treats min as inclusive', () => {
    expect(() => assertInteger(1, 'ttl', { min: 1 })).not.toThrow();
    expect(() => assertInteger(0, 'ttl', { min: 1 })).toThrow(/>= 1/);
  });

  it('treats max as inclusive', () => {
    expect(() => assertInteger(10, 'ttl', { max: 10 })).not.toThrow();
    expect(() => assertInteger(11, 'ttl', { max: 10 })).toThrow(/<= 10/);
  });

  it('applies both bounds when both are given', () => {
    expect(() => assertInteger(5, 'ttl', { min: 1, max: 10 })).not.toThrow();
    expect(() => assertInteger(0, 'ttl', { min: 1, max: 10 })).toThrow(/>= 1/);
    expect(() => assertInteger(11, 'ttl', { min: 1, max: 10 })).toThrow(/<= 10/);
  });

  it('reports the integer rule before either bound', () => {
    expect(() => assertInteger(0.5, 'ttl', { min: 1 })).toThrow(/integer/);
  });
});

describe('assertStringArray', () => {
  it.each([undefined, null, 'abc', 42, {}] as never[])('rejects the non-array %p', (value) => {
    expectValidationError(() => assertStringArray(value, 'channels'), 'channels');
  });

  it('rejects an array holding a non-string element', () => {
    expectValidationError(() => assertStringArray(['a', 1 as never], 'channels'), 'channels');
  });

  it('accepts an empty array and an array of strings', () => {
    expect(() => assertStringArray([], 'channels')).not.toThrow();
    expect(() => assertStringArray(['a', 'b'], 'channels')).not.toThrow();
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

describe('parseKeySegment', () => {
  it.each(NON_STRINGS)('rejects the non-string %p', (value) => {
    expectValidationError(() => parseKeySegment(value, '#', 'namespace', 1024), 'namespace');
  });

  it('rejects a value containing the separator', () => {
    expectValidationError(() => parseKeySegment('a#b', '#', 'namespace', 1024), 'namespace');
  });

  it('accepts a value without it', () => {
    expect(() => parseKeySegment('ab', '#', 'namespace', 1024)).not.toThrow();
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

describe('parseIdentifier', () => {
  it('accepts a value satisfying every rule', () => {
    expect(() => parseIdentifier('thread-1', '#', 'thread_id', 1024)).not.toThrow();
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
    expect(() => parseIdentifier(value, '#', 'thread_id', maxBytes)).toThrow(message);
  });

  it('rejects an ill-formed identifier that breaks no other rule', () => {
    expectValidationError(
      () => parseIdentifier(`tenant${HIGH}`, '#', 'thread_id', 1024),
      'thread_id',
    );
  });

  /**
   * The deliberate half of the rule, locked so it cannot reverse by accident.
   * Format characters and the Unicode line separators are accepted, because
   * refusing them would refuse ordinary text: `U+200C` and `U+200D` carry
   * meaning in Persian and the Indic scripts, and `U+200D` joins every
   * multi-person emoji. What they cost is a log line or a console that renders
   * two identifiers alike, not a row either can reach.
   */
  it.each([
    ['zero width space', 'a\u200Bb'],
    ['zero width non-joiner, as Persian spells mi-ravad', '\u0645\u06CC\u200C\u0631\u0648\u062F'],
    ['zero width joiner, as a multi-person emoji is built', '\u{1F468}\u200D\u{1F469}'],
    ['byte order mark', 'a\uFEFFb'],
    ['right-to-left override', 'a\u202Eb'],
    ['line separator', 'a\u2028b'],
    ['paragraph separator', 'a\u2029b'],
  ])('accepts an identifier holding a %s', (_name, value) => {
    expect(() => parseIdentifier(value, '#', 'thread_id', 1024)).not.toThrow();
  });

  /**
   * And the identifier is not normalised, which is what keeps an upgrade safe.
   * Normalising would map these two onto one key, so a row written under the
   * decomposed form would stop being found under the composed one.
   */
  it('keeps two identifiers distinct when only their Unicode composition differs', () => {
    const composed = 'caf\u00E9';
    const decomposed = 'cafe\u0301';
    expect(composed).not.toBe(decomposed);
    expect(composed.normalize('NFC')).toBe(decomposed.normalize('NFC'));
    expect(() => parseIdentifier(composed, '#', 'thread_id', 1024)).not.toThrow();
    expect(() => parseIdentifier(decomposed, '#', 'thread_id', 1024)).not.toThrow();
    expect(Buffer.from(composed, 'utf8').toString('base64url')).not.toBe(
      Buffer.from(decomposed, 'utf8').toString('base64url'),
    );
  });

  /** Two identifiers that encode to one key must not both be accepted. */
  it('rejects the one of two identifiers that would share an encoded key', () => {
    const lossy = `tenant${HIGH}`;
    const replacement = 'tenant�';
    expect(Buffer.from(lossy, 'utf8').toString('base64url')).toBe(
      Buffer.from(replacement, 'utf8').toString('base64url'),
    );
    expect(() => parseIdentifier(lossy, '#', 'thread_id', 1024)).toThrow();
    expect(() => parseIdentifier(replacement, '#', 'thread_id', 1024)).not.toThrow();
  });
});

describe('parseString', () => {
  it('returns a string as it was given', () => {
    expect(parseString('', 'f')).toBe('');
    expect(parseString('x', 'f')).toBe('x');
  });
  it.each(NON_STRINGS)('refuses %p, naming the field', (value) => {
    expectValidationError(() => parseString(value, 'f'), 'f');
  });
});

describe('parseInteger', () => {
  it('returns an integer inside its bounds', () => {
    expect(parseInteger(3, 'n')).toBe(3);
    expect(parseInteger(0, 'n', { min: 0, max: 0 })).toBe(0);
  });
  it.each([1.5, Number.NaN, Infinity, '1', null, undefined])(
    'refuses %p as not an integer',
    (value) => {
      expect(() => parseInteger(value, 'n')).toThrow('n must be an integer');
    },
  );
  it('reports the bound broken', () => {
    expect(() => parseInteger(-1, 'n', { min: 0 })).toThrow('n must be >= 0');
    expect(() => parseInteger(11, 'n', { max: 10 })).toThrow('n must be <= 10');
  });
});

describe('parseLimit', () => {
  it('returns the page size, typed as one that was checked', () => {
    const limit = parseLimit(MAX_PAGE_LIMIT, 0);
    expect(limit).toBe(MAX_PAGE_LIMIT);
    expectTypeOf(limit).toEqualTypeOf<PageLimit>();
    expectTypeOf<number>().not.toMatchTypeOf<PageLimit>();
    expect(parseLimit(0, 0)).toBe(0);
  });
  it('refuses zero at a floor of one, and anything past the ceiling', () => {
    expectValidationError(() => parseLimit(0, 1), 'limit');
    expect(() => parseLimit(MAX_PAGE_LIMIT + 1, 0)).toThrow(`limit must be <= ${MAX_PAGE_LIMIT}`);
    expectValidationError(() => parseLimit('5', 0), 'limit');
  });
});

describe('parseKeySegment', () => {
  it('accepts the empty string, which is a segment and not an absence', () => {
    expect(parseKeySegment('', '#', 'ns', 256)).toBe('');
    expect(parseKeySegment('inner', '#', 'ns', 256)).toBe('inner');
  });
  it('applies every identifier rule but non-blank, in order', () => {
    expectValidationError(() => parseKeySegment(1, '#', 'ns', 256), 'ns');
    expect(() => parseKeySegment('x'.repeat(257), '#', 'ns', 256)).toThrow(/at most 256 bytes/);
    expect(() => parseKeySegment('a#b', '#', 'ns', 256)).toThrow(/separator/);
    expect(() => parseKeySegment('a\nb', '#', 'ns', 256)).toThrow(/control characters/);
    expect(() => parseKeySegment(`a${HIGH}b`, '#', 'ns', 256)).toThrow(/well-formed/);
  });
});

describe('parseIdentifier', () => {
  it('returns a well-formed identifier', () => {
    expect(parseIdentifier(`${HIGH}${LOW}`, '#', 'id', 256)).toBe(`${HIGH}${LOW}`);
  });
  it('refuses a blank one before any other rule', () => {
    expect(() => parseIdentifier('   ', '#', 'id', 1)).toThrow(/non-empty/);
    expectValidationError(() => parseIdentifier(undefined, '#', 'id', 256), 'id');
  });
});

describe('parseStringArray', () => {
  it('returns a copy, so a later change to the caller array does not reach it', () => {
    const given = ['a', 'b'];
    const parsed = parseStringArray(given, 'fields');
    given.push('c');
    expect(parsed).toEqual(['a', 'b']);
  });
  it.each([undefined, 'a', [1], ['a', null]])('refuses %p', (value) => {
    expectValidationError(() => parseStringArray(value, 'fields'), 'fields');
  });
});
