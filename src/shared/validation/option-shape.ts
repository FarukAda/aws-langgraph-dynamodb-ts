import { ValidationError } from '../errors/errors';

/**
 * Every key of `T`, listed once.
 *
 * Accepts: an object naming every key of `T` as its own value. The parameter's
 * type makes the list exhaustive in both directions: omitting a key the type
 * declares, or naming one it does not, fails to compile — so the list cannot
 * drift from the option type it guards, which matters because the list is what
 * decides that a key is *unknown*.
 *
 * Returns: the keys.
 *
 * Throws: nothing.
 */
export function allKeysOf<T extends object>(keys: {
  [K in keyof Required<T>]: K;
}): readonly string[] {
  return Object.values(keys);
}

/**
 * Reject an option object that is not an object, or that carries a key this
 * package does not read.
 *
 * Accepts: `value` — the option object as the caller gave it. `allowed` — the
 * key list from {@link allKeysOf}. `field` — what the error names.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `field` for a value that is not an object, and
 * `field.key` for an unknown key. A misspelt key is otherwise accepted and
 * ignored, and the caller runs on a default they believe they overrode.
 */
export function assertShape(value: object, allowed: readonly string[], field: string): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ValidationError(`${field} must be an object`, field);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new ValidationError(
        `${field}.${key} is not an option this package reads; expected one of ${allowed.join(', ')}`,
        `${field}.${key}`,
      );
    }
  }
}
