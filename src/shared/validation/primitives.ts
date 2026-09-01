import { ValidationError } from '../errors/errors';

/** Throw {@link ValidationError} unless `value` is a non-empty string. */
export function validateNonEmptyString(value: string, field: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`, field);
  }
}

/** Throw {@link ValidationError} unless `value` is an integer within bounds. */
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

/** Throw {@link ValidationError} unless `value` is a non-empty array. */
export function validateNonEmptyArray<T>(value: T[], field: string): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ValidationError(`${field} must be a non-empty array`, field);
  }
}

/** Return `true` if `value` contains any ASCII control character. */
function hasControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** Throw {@link ValidationError} if `value` contains an ASCII control character. */
export function assertNoControlChars(value: string, field: string): void {
  if (hasControlChar(value)) {
    throw new ValidationError(`${field} must not contain control characters`, field);
  }
}

/** Throw {@link ValidationError} if `value` contains the reserved `separator`. */
export function assertNoSeparator(value: string, separator: string, field: string): void {
  if (value.includes(separator)) {
    throw new ValidationError(
      `${field} must not contain the reserved "${separator}" separator`,
      field,
    );
  }
}

/**
 * Validate a caller-supplied identifier that reaches a DynamoDB key: non-empty,
 * free of the reserved `separator`, and free of control characters. The last
 * rule matters even though DynamoDB itself accepts control characters — an
 * identifier is echoed into logs, so an unvalidated ANSI escape is a
 * log/terminal-injection surface for any app that writes these values out.
 */
export function validateIdentifier(value: string, separator: string, field: string): void {
  validateNonEmptyString(value, field);
  assertNoSeparator(value, separator, field);
  assertNoControlChars(value, field);
}
