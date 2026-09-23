import { validationError } from '../errors/errors';

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
 * Whether a value is a plain object: an object at all, not `null`, and not an
 * array.
 *
 * Accepts: `value` — as the caller gave it, `undefined` included.
 *
 * Returns: true exactly when {@link assertObjectShape} would accept `value`.
 * For code that must decide what to do with a malformed value rather than
 * refuse it on the spot.
 *
 * Throws: nothing.
 */
export function isObjectShape(value: object | undefined): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reject a value that is not a plain object: not an object at all, `null`, or
 * an array.
 *
 * Accepts: `value` — as the caller gave it. `field` — what the error names.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `field`.
 */
export function assertObjectShape(value: object, field: string): void {
  if (!isObjectShape(value)) {
    throw validationError(`${field} must be an object`, field);
  }
}

/**
 * Reject an option object that is not an object, or that carries a key this
 * package does not read.
 *
 * Accepts: `value` — the option object as the caller gave it. `allowed` — the
 * key list from {@link allKeysOf}. `field` — what the error names.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `field` for a value that is not an object, and
 * `field.key` for an unknown key. A misspelt key is otherwise accepted and
 * ignored, and the caller runs on a default they believe they overrode.
 *
 * `field.key` is **deliberately not cut**, where the rule that bounds an
 * unchecked string before a message quotes it would otherwise reach it. The
 * same string is the message *and* `context.field`, and `context.field` is the
 * compatibility surface a caller branches on, so cutting one and not the other
 * would make an error disagree with itself about which option it refused.
 * Cutting both would bound a field callers match on, which this package does
 * not do. The value is also the caller's own key off the caller's own options
 * object — neither row-sourced nor third-party — so the only person who can
 * make it enormous is the person reading the error.
 */
export function assertShape(value: object, allowed: readonly string[], field: string): void {
  assertObjectShape(value, field);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw validationError(
        `${field}.${key} is not an option this package reads; expected one of ${allowed.join(', ')}`,
        `${field}.${key}`,
      );
    }
  }
}

/**
 * {@link assertShape}, returning `value` instead of nothing.
 *
 * Accepts: the same arguments as {@link assertShape}.
 *
 * Returns: `value`, unchanged. This returning form exists because a subclass
 * constructor cannot run a statement before `super(...)`, so validating an
 * argument bound for `super(...)` has to happen inside that expression —
 * `super(checkedShape(options, ALLOWED, 'options').thing)` — where a `void`
 * function would not compile.
 *
 * Throws: the same as {@link assertShape}.
 */
export function checkedShape<T extends object>(
  value: T,
  allowed: readonly string[],
  field: string,
): T {
  assertShape(value, allowed, field);
  return value;
}
