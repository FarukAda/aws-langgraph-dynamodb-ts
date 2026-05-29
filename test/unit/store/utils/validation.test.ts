/**
 * Unit tests for src/store/utils/validation.ts.
 *
 * Plan rows:
 *   AC-17 — each validateX throws the specific error type/message on invalid
 *           input and returns on valid, with boundary rows (empty, whitespace,
 *           leading/trailing slash, control chars, reserved words, segments
 *           containing '#' or '/').
 *   AC-32 — DDB encoding-limit cases on validateValue (§5.E), each asserting the
 *           validator's documented outcome.
 *
 * REQ-21 / REQ-36 / AC-17 / AC-32.
 *
 * Pinned from src/store/utils/validation.ts:
 *   - All store validators throw `ValidationError` (subclass of Error, name
 *     'ValidationError') with exact messages.
 *   - validateNamespace: array required; non-empty; <= 20 deep; root != 'langgraph';
 *     each part a non-empty string with no '.', '#', or '/'.
 *   - validateKey: string; non-empty; <= 1024 chars; no '#'.
 *   - validateValue: rejects only top-level `undefined` ("Value cannot be
 *     undefined") and values whose JSON.stringify byte size exceeds 400 KB. It
 *     does NOT inspect NaN / Infinity / nested undefined / depth — those are
 *     JSON-coerced (NaN/Infinity -> null, undefined map entries dropped), so the
 *     §5.E "coerce" outcome is asserted as non-throwing here.
 *   - validateTTL: wraps shared validateTTLDays, re-throwing as ValidationError;
 *     undefined is allowed; integer 1..1825 allowed; else throws.
 */
import {
  validateNamespace,
  validateKey,
  validateValue,
  validateTTL,
  validatePagination,
  validateEmbeddings,
  validateUserId,
  validateJSONPath,
  validateMaxDepth,
  validateBatchSize,
  ValidationError,
} from '../../../../src/store/utils/validation';
import { runValidatorCases } from '../../../shared/helpers/validation-tests';

describe('ValidationError carries the exact name (kills name = "" StringLiteral mutant)', () => {
  it('sets .name to the literal "ValidationError" on a thrown instance', () => {
    let caught: unknown;
    try {
      validateKey('');
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as Error).name).toBe('ValidationError');
  }); // AC-17
});

describe('validateNamespace', () => {
  runValidatorCases(
    validateNamespace as (...a: never[]) => unknown,
    [
      // positive
      { name: 'accepts a normal single-segment namespace', args: [['ns']], throws: false },
      { name: 'accepts a normal multi-segment namespace', args: [['a', 'b', 'c']], throws: false },
      // negatives with pinned messages
      {
        name: 'rejects a non-array namespace',
        args: ['ns'],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Namespace must be an array',
      },
      {
        name: 'rejects an empty namespace array',
        args: [[]],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Namespace cannot be empty',
      },
      {
        name: 'rejects a non-string namespace part',
        args: [[42]],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Namespace parts must be strings',
      },
      {
        name: 'accepts a namespace at exactly the 20-level maximum depth',
        args: [Array.from({ length: 20 }, (_, i) => `s${i}`)],
        throws: false,
      },
      {
        name: 'rejects an empty-string segment',
        args: [['']],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Namespace parts cannot be empty strings',
      },
      {
        name: 'rejects a segment containing a slash',
        args: [['seg/ment']],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Namespace parts cannot contain "/" character',
      },
      {
        name: 'rejects a segment containing a hash',
        args: [['seg#ment']],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Namespace parts cannot contain "#" character',
      },
      {
        name: 'rejects a segment containing a dot',
        args: [['seg.ment']],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Namespace parts cannot contain "." character',
      },
      {
        name: 'rejects the reserved "langgraph" root label',
        args: [['langgraph', 'x']],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Namespace root label "langgraph" is reserved',
      },
      {
        name: 'rejects namespace depth above the 20-level maximum',
        args: [Array.from({ length: 21 }, (_, i) => `s${i}`)],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Namespace depth exceeds maximum of 20 levels',
      },
    ],
    '// AC-17',
  );
});

describe('validateKey', () => {
  runValidatorCases(
    validateKey as (...a: never[]) => unknown,
    [
      { name: 'accepts a normal key', args: ['key1'], throws: false },
      {
        // Boundary: > 1024 throws; exactly 1024 must pass (kills > -> >= on line 91).
        name: 'accepts a key at exactly the 1024-char maximum (boundary)',
        args: ['x'.repeat(1024)],
        throws: false,
      },
      {
        name: 'rejects a non-string key',
        args: [123],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Key must be a string',
      },
      {
        name: 'rejects an empty string key',
        args: [''],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Key cannot be empty',
      },
      {
        name: 'rejects a key containing a hash (namespace_key delimiter)',
        args: ['k#ey'],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Key cannot contain "#" character',
      },
      {
        name: 'rejects a key longer than 1024 characters',
        args: ['x'.repeat(1025)],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Key exceeds maximum length of 1024 characters',
      },
    ],
    '// AC-17',
  );

  it('accepts a whitespace-only key (whitespace is a valid non-empty string)', () => {
    // Boundary: validateKey only rejects empty / oversize / '#'; whitespace is
    // a legitimate non-empty key and must pass.
    let ran = false;
    expect(() => {
      validateKey('   ');
      ran = true;
    }).not.toThrow();
    expect(ran).toBe(true);
  }); // AC-17
});

describe('validateTTL', () => {
  runValidatorCases(
    validateTTL as (...a: never[]) => unknown,
    [
      { name: 'accepts undefined (TTL optional)', args: [undefined], throws: false },
      { name: 'accepts a positive integer ttl', args: [30], throws: false },
      {
        name: 'rejects a negative ttl',
        args: [-1],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'TTL days must be positive',
      },
      {
        name: 'rejects a zero ttl',
        args: [0],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'TTL days must be positive',
      },
      {
        name: 'rejects a non-integer ttl',
        args: [1.5],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'TTL days must be an integer',
      },
      {
        name: 'rejects a NaN ttl',
        args: [Number.NaN],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'TTL days must be an integer',
      },
      {
        name: 'rejects a ttl above the maximum allowed days',
        args: [1826],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'TTL days cannot exceed',
      },
    ],
    '// AC-17',
  );
});

describe('validateValue', () => {
  it('returns normally for a plain serializable object', () => {
    let ran = false;
    expect(() => {
      validateValue({ data: 'value', count: 1, nested: { ok: true } });
      ran = true;
    }).not.toThrow();
    expect(ran).toBe(true);
  }); // AC-17

  it('rejects a top-level undefined value with the documented message', () => {
    expect(() => validateValue(undefined)).toThrow(ValidationError);
    expect(() => validateValue(undefined)).toThrow('Value cannot be undefined');
  }); // AC-17
});

describe('validateValue DDB encoding-limit cases (§5.E)', () => {
  // AC-32: validateValue's documented behavior is reject-on-top-level-undefined
  // and reject-on-oversize; all other JSON-encodable shapes are coerced by
  // JSON.stringify and pass. Each case asserts that exact outcome.

  it('coerces (does not reject) an undefined value nested inside a map', () => {
    // JSON.stringify drops undefined map entries => {"a":undefined} -> "{}".
    let ran = false;
    expect(() => {
      validateValue({ a: undefined });
      ran = true;
    }).not.toThrow();
    expect(ran).toBe(true);
  }); // AC-32

  it('coerces (does not reject) a NaN number entry', () => {
    // JSON.stringify(NaN) -> null; validateValue does not inspect numeric finiteness.
    let ran = false;
    expect(() => {
      validateValue({ n: Number.NaN });
      ran = true;
    }).not.toThrow();
    expect(ran).toBe(true);
  }); // AC-32

  it('coerces (does not reject) an Infinity number entry', () => {
    let ran = false;
    expect(() => {
      validateValue({ n: Number.POSITIVE_INFINITY });
      ran = true;
    }).not.toThrow();
    expect(ran).toBe(true);
  }); // AC-32

  it('coerces (does not reject) a number greater than 2^53', () => {
    // validateValue is size-based only; integer-precision is not its concern.
    let ran = false;
    expect(() => {
      validateValue({ n: 2 ** 53 + 1 });
      ran = true;
    }).not.toThrow();
    expect(ran).toBe(true);
  }); // AC-32

  it('coerces (does not reject) a value nested deeper than 32 levels', () => {
    // validateValue does not enforce a depth limit; deep nesting is JSON-serialized.
    let deep: Record<string, unknown> = { leaf: 'end' };
    for (let i = 0; i < 40; i += 1) {
      deep = { child: deep };
    }
    let ran = false;
    expect(() => {
      validateValue(deep);
      ran = true;
    }).not.toThrow();
    expect(ran).toBe(true);
  }); // AC-32

  it('accepts an empty-string attribute value (empty string is encodable)', () => {
    let ran = false;
    expect(() => {
      validateValue({ s: '' });
      ran = true;
    }).not.toThrow();
    expect(ran).toBe(true);
  }); // AC-32

  it('accepts a value whose JSON size is EXACTLY 409600 bytes (boundary: > rejects, == passes)', () => {
    // JSON.stringify(string) === '"' + string + '"' => length + 2 bytes (ASCII).
    // length 409598 -> serialized byte size exactly 409600 (MAX_VALUE_SIZE).
    const exact = 'a'.repeat(400 * 1024 - 2);
    const serialized = new TextEncoder().encode(JSON.stringify(exact)).byteLength;
    expect(serialized).toBe(409600); // pin the boundary precisely
    let ran = false;
    expect(() => {
      validateValue(exact);
      ran = true;
    }).not.toThrow();
    expect(ran).toBe(true);
  }); // AC-32

  it('rejects early a value whose JSON size exceeds the 400KB item limit', () => {
    // §5.E: > 400KB -> reject early at the validator (offload is decided upstream
    // in the put action, not here). The serialized size exceeds 400*1024 bytes.
    const big = { blob: 'x'.repeat(450 * 1024) };
    expect(() => validateValue(big)).toThrow(ValidationError);
    expect(() => validateValue(big)).toThrow(/exceeds maximum of 409600 bytes/);
  }); // AC-32
});

describe('validatePagination', () => {
  runValidatorCases(
    validatePagination as (...a: never[]) => unknown,
    [
      // positive — both undefined is the no-op path
      { name: 'accepts undefined limit and offset (both optional)', args: [], throws: false },
      { name: 'accepts a zero limit (boundary, non-negative)', args: [0, 0], throws: false },
      { name: 'accepts the maximum allowed limit (boundary 1000)', args: [1000, 0], throws: false },
      {
        name: 'accepts the maximum allowed offset (boundary 10000)',
        args: [10, 10000],
        throws: false,
      },
      // limit branches
      {
        name: 'rejects a non-integer (float) limit',
        args: [1.5],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Limit must be an integer',
      },
      {
        name: 'rejects a non-number (string) limit',
        args: ['10'],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Limit must be an integer',
      },
      {
        name: 'rejects a negative limit',
        args: [-1],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Limit cannot be negative',
      },
      {
        name: 'rejects a limit above the 1000 maximum',
        args: [1001],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Limit cannot exceed 1000',
      },
      // offset branches
      {
        name: 'rejects a non-integer (float) offset',
        args: [10, 2.5],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Offset must be an integer',
      },
      {
        name: 'rejects a non-number (string) offset',
        args: [10, '5'],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Offset must be an integer',
      },
      {
        name: 'rejects a negative offset',
        args: [10, -1],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Offset cannot be negative',
      },
      {
        name: 'rejects an offset above the 10000 maximum',
        args: [10, 10001],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Offset cannot exceed 10000',
      },
    ],
    '// AC-17',
  );
});

describe('validateEmbeddings', () => {
  runValidatorCases(
    validateEmbeddings as (...a: never[]) => unknown,
    [
      // positive
      { name: 'accepts undefined embeddings (optional)', args: [undefined], throws: false },
      { name: 'accepts a single valid embedding vector', args: [[[0.1, 0.2, 0.3]]], throws: false },
      {
        // Boundary: > 100 throws; exactly 100 passes (kills > -> >= on line 173).
        name: 'accepts exactly 100 embeddings (boundary)',
        args: [Array.from({ length: 100 }, () => [0.1])],
        throws: false,
      },
      {
        // Boundary: > 10000 dims throws; exactly 10000 passes (kills > -> >= on line 188).
        name: 'accepts an embedding with exactly 10000 dimensions (boundary)',
        args: [[Array.from({ length: 10000 }, () => 0.1)]],
        throws: false,
      },
      // top-level shape
      {
        name: 'rejects a non-array embeddings container',
        args: ['not-an-array'],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Embeddings must be an array',
      },
      {
        name: 'rejects more embeddings than the per-item maximum',
        args: [Array.from({ length: 101 }, () => [0.1])],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'exceeds maximum of 100',
      },
      // per-embedding shape
      {
        name: 'rejects an embedding entry that is not an array',
        args: [[42]],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Each embedding must be an array of numbers',
      },
      {
        name: 'rejects an empty embedding vector',
        args: [[[]]],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Embedding cannot be empty',
      },
      {
        name: 'rejects an embedding exceeding the dimension maximum',
        args: [[Array.from({ length: 10001 }, () => 0.1)]],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'exceed maximum of 10000',
      },
      {
        name: 'rejects an embedding with a non-number value',
        args: [[['x']]],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Embedding values must be finite numbers',
      },
      {
        name: 'rejects an embedding with a non-finite (NaN) value',
        args: [[[Number.NaN]]],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Embedding values must be finite numbers',
      },
      {
        name: 'rejects an embedding with an Infinity value',
        args: [[[Number.POSITIVE_INFINITY]]],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Embedding values must be finite numbers',
      },
    ],
    '// AC-17',
  );
});

describe('validateUserId', () => {
  runValidatorCases(
    validateUserId as (...a: never[]) => unknown,
    [
      { name: 'accepts a normal user id', args: ['user-1'], throws: false },
      {
        name: 'accepts a user id at exactly the 256-char maximum',
        args: ['u'.repeat(256)],
        throws: false,
      },
      {
        name: 'rejects a non-string user id',
        args: [42],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'User ID must be a string',
      },
      {
        name: 'rejects an empty user id',
        args: [''],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'User ID cannot be empty',
      },
      {
        name: 'rejects a user id above the 256-char maximum',
        args: ['u'.repeat(257)],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'User ID exceeds maximum length of 256 characters',
      },
    ],
    '// AC-17',
  );
});

describe('validateJSONPath', () => {
  runValidatorCases(
    validateJSONPath as (...a: never[]) => unknown,
    [
      // positive
      { name: 'accepts an empty paths array (no-op)', args: [[]], throws: false },
      { name: 'accepts a normal JSONPath expression', args: [['$.data.value']], throws: false },
      {
        name: 'accepts a path that merely contains "constructor" as a substring (not a step)',
        args: [['$.constructors[0]']],
        throws: false,
      },
      {
        // Boundary: > 50 throws; exactly 50 passes (kills > -> >= on line 231).
        name: 'accepts exactly 50 JSONPath expressions (boundary)',
        args: [Array.from({ length: 50 }, (_, i) => `$.f${i}`)],
        throws: false,
      },
      {
        // Boundary: > 500 throws; exactly 500 passes (kills > -> >= on line 244).
        // 'a'.repeat(500) is exactly MAX_JSONPATH_LENGTH characters.
        name: 'accepts a JSONPath expression of exactly 500 characters (boundary)',
        args: [['a'.repeat(500)]],
        throws: false,
      },
      {
        // Regex ^ anchor: a path STARTING with __proto__ (no preceding . or [)
        // only matches via the `^` alternative. Kills the mutant that drops `^`.
        name: 'rejects a __proto__ step at the very start of the path (^ anchor)',
        args: [['__proto__.x']],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'contains disallowed patterns',
      },
      {
        // Regex $ anchor: a path ENDING with __proto__ (no trailing . [ ])
        // only matches via the `$` alternative. Kills the mutant that drops `$`.
        name: 'rejects a __proto__ step at the very end of the path ($ anchor)',
        args: [['$.x.__proto__']],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'contains disallowed patterns',
      },
      // shape
      {
        name: 'rejects a non-array paths argument',
        args: ['$.x'],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'JSONPath index must be an array',
      },
      {
        name: 'rejects more than 50 JSONPath expressions',
        args: [Array.from({ length: 51 }, (_, i) => `$.f${i}`)],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Too many JSONPath expressions (maximum 50)',
      },
      {
        name: 'rejects a non-string JSONPath entry',
        args: [[42]],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'JSONPath expression must be a string',
      },
      {
        name: 'rejects an empty-string JSONPath entry',
        args: [['']],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'JSONPath expression cannot be empty',
      },
      {
        name: 'rejects a JSONPath entry above the length maximum',
        args: [['$.' + 'a'.repeat(500)]],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'exceeds maximum length of 500 characters',
      },
      {
        name: 'rejects a prototype-pollution __proto__ property step',
        args: [['$.__proto__.polluted']],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'contains disallowed patterns',
      },
      {
        name: 'rejects a prototype-pollution constructor property step',
        args: [['$.constructor.prototype']],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'contains disallowed patterns',
      },
    ],
    '// AC-17',
  );
});

describe('validateMaxDepth', () => {
  runValidatorCases(
    validateMaxDepth as (...a: never[]) => unknown,
    [
      { name: 'accepts undefined maxDepth (optional)', args: [undefined], throws: false },
      { name: 'accepts the minimum maxDepth of 1', args: [1], throws: false },
      { name: 'accepts the maximum maxDepth of 100', args: [100], throws: false },
      {
        name: 'rejects a non-integer (float) maxDepth',
        args: [2.5],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'maxDepth must be an integer',
      },
      {
        name: 'rejects a non-number (string) maxDepth',
        args: ['3'],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'maxDepth must be an integer',
      },
      {
        name: 'rejects a maxDepth below 1',
        args: [0],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'maxDepth must be at least 1',
      },
      {
        name: 'rejects a maxDepth above the 100 maximum',
        args: [101],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'maxDepth cannot exceed 100',
      },
    ],
    '// AC-17',
  );
});

describe('validateBatchSize', () => {
  runValidatorCases(
    validateBatchSize as (...a: never[]) => unknown,
    [
      { name: 'accepts the minimum batch size of 1', args: [1], throws: false },
      { name: 'accepts the maximum batch size of 100', args: [100], throws: false },
      {
        name: 'rejects a non-integer (float) batch count',
        args: [1.5],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Operations count must be an integer',
      },
      {
        name: 'rejects a non-number (string) batch count',
        args: ['5'],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Operations count must be an integer',
      },
      {
        name: 'rejects a batch count below 1',
        args: [0],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'Batch must contain at least one operation',
      },
      {
        name: 'rejects a batch count above the 100 maximum',
        args: [101],
        throws: true,
        expectedErrorType: ValidationError,
        expectedMessageSubstring: 'exceeds maximum of 100 operations',
      },
    ],
    '// AC-17',
  );
});
