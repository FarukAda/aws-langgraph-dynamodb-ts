import { ValidationError } from '../errors/errors';

/**
 * Throw {@link ValidationError} unless `value` is a string.
 *
 * Accepts: `value` — declared `string`; a JavaScript caller, or a TypeScript
 * caller whose config came from JSON, can pass any other type, and every check
 * below would otherwise reach a string method and raise a raw `TypeError`
 * instead of this package's error.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `field`, for anything that is not a string.
 */
function assertString(value: string, field: string): void {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string`, field);
  }
}

/**
 * Throw {@link ValidationError} unless `value` is a string holding at least one
 * non-whitespace character.
 *
 * Accepts: `value` — any type; `''` and whitespace-only are rejected alongside
 * non-strings. `field` — the option or identifier name carried on the error.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `field`.
 */
export function validateNonEmptyString(value: string, field: string): void {
  assertString(value, field);
  if (value.trim().length === 0) {
    throw new ValidationError(
      `${field} must be a non-empty string (whitespace-only counts as empty)`,
      field,
    );
  }
}

/**
 * Throw {@link ValidationError} unless `value` encodes to at most `maxBytes` of
 * UTF-8.
 *
 * Accepts: `value` — any type, non-strings rejected first. `maxBytes` — a byte
 * budget from `shared/constants`, measured in UTF-8 bytes rather than UTF-16
 * code units because that is what DynamoDB and S3 count.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `field`.
 */
export function assertMaxBytes(value: string, field: string, maxBytes: number): void {
  assertString(value, field);
  const bytes = Buffer.byteLength(value, 'utf8');
  if (bytes > maxBytes) {
    throw new ValidationError(
      `${field} must be at most ${maxBytes} bytes of UTF-8 (received ${bytes})`,
      field,
    );
  }
}

/**
 * Throw {@link ValidationError} unless `value` is an integer inside `bounds`.
 *
 * Accepts: `value` — any type; a non-number, a fraction, `NaN` and `Infinity`
 * are all rejected by the integer rule. `bounds` — omitted or `{}` bounds
 * nothing, `min` and `max` are inclusive and may be given together or alone.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `field`; the integer rule is reported before
 * either bound.
 */
export function validateInteger(
  value: number,
  field: string,
  bounds: { min?: number; max?: number } = {},
): void {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError(`${field} must be an integer`, field);
  }
  if (bounds.min !== undefined && value < bounds.min) {
    throw new ValidationError(`${field} must be >= ${bounds.min}`, field);
  }
  if (bounds.max !== undefined && value > bounds.max) {
    throw new ValidationError(`${field} must be <= ${bounds.max}`, field);
  }
}

/**
 * Throw {@link ValidationError} unless `value` is an array holding at least one
 * element.
 *
 * Accepts: `value` — any type; a non-array and `[]` are both rejected. The
 * elements themselves are not inspected.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `field`.
 */
export function validateNonEmptyArray<T>(value: T[], field: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError(`${field} must be a non-empty array`, field);
  }
}

/**
 * Throw {@link ValidationError} unless `value` is an array of strings.
 *
 * Accepts: `value` — declared `readonly string[]` for a caller whose types
 * hold; a non-array is rejected, as is an array holding anything but a
 * string. An empty array is valid.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `field`.
 */
export function validateStringArray(value: readonly string[], field: string): void {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ValidationError(`${field} must be an array of strings`, field);
  }
}

/** True when `value` holds a C0 control character, DEL, or a C1 control character. */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Throw {@link ValidationError} unless `value` is free of control characters.
 *
 * Accepts: `value` — any type, non-strings rejected first. Rejected code points
 * are C0 (`U+0000`–`U+001F`), DEL (`U+007F`) and C1 (`U+0080`–`U+009F`).
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `field`.
 *
 * Guarantees: an accepted value cannot terminate a log line or open a terminal
 * escape sequence — neither `ESC` (`U+001B`) nor the single-byte `CSI`
 * (`U+009B`) survives this rule. Identifiers are written into log lines by this
 * package, and unneutralised output is CWE-117
 * (https://cwe.mitre.org/data/definitions/117.html).
 */
export function assertNoControlChars(value: string, field: string): void {
  assertString(value, field);
  if (hasControlChar(value)) {
    throw new ValidationError(`${field} must not contain control characters`, field);
  }
}

/**
 * Throw {@link ValidationError} unless every surrogate in `value` is part of a
 * pair.
 *
 * Accepts: `value` — any type, non-strings rejected first.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `field`.
 *
 * Guarantees: the mapping from an accepted value to its UTF-8 encoding is
 * injective. `Buffer.from(value, 'utf8')` replaces a lone surrogate with
 * U+FFFD, so two values differing only there would encode identically and,
 * where that encoding is a storage key, address one object.
 */
export function assertWellFormed(value: string, field: string): void {
  assertString(value, field);
  if (!value.isWellFormed()) {
    throw new ValidationError(
      `${field} must be well-formed UTF-16 (it contains an unpaired surrogate, which does not ` +
        'survive encoding to UTF-8)',
      field,
    );
  }
}

/**
 * Throw {@link ValidationError} if `value` contains `separator`.
 *
 * Accepts: `value` — any type, non-strings rejected first. `separator` — the
 * reserved character joining key segments, `'#'` for every key this package
 * composes (`src/checkpointer/internal/keys.ts:5`).
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `field`.
 */
export function assertNoSeparator(value: string, separator: string, field: string): void {
  assertString(value, field);
  if (value.includes(separator)) {
    throw new ValidationError(
      `${field} must not contain the reserved "${separator}" separator`,
      field,
    );
  }
}

/**
 * Validate a caller-supplied identifier that reaches a DynamoDB key or an S3
 * object key.
 *
 * Accepts: `value` — any type. `separator`, `field`, `maxBytes` — as the rules
 * below.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `field`. The rules apply in this order, and
 * the order is part of the contract because a caller branches on which one
 * failed: string, non-blank, at most `maxBytes` of UTF-8, free of `separator`,
 * free of control characters, well-formed UTF-16.
 *
 * Guarantees: every guarantee of {@link assertNoControlChars} and
 * {@link assertWellFormed} holds for an accepted value, and it composes into a
 * key segment without escaping.
 */
export function validateIdentifier(
  value: string,
  separator: string,
  field: string,
  maxBytes: number,
): void {
  validateNonEmptyString(value, field);
  assertMaxBytes(value, field, maxBytes);
  assertNoSeparator(value, separator, field);
  assertNoControlChars(value, field);
  assertWellFormed(value, field);
}
