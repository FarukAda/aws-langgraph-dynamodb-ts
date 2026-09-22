/**
 * A description of a thrown value that is not an `Error`, for its message.
 *
 * `JSON.stringify` is the best available rendering and it throws on a circular
 * structure and on a `BigInt`, so it is guarded: this runs inside a `catch`,
 * where throwing would replace the failure the caller is trying to report.
 */
function describeThrown(value: Error): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return `${String(value)} was thrown`;
  try {
    return JSON.stringify(value) ?? `a ${typeof value} value was thrown`;
  } catch {
    return `an unserializable ${typeof value} value was thrown`;
  }
}

/**
 * A caught value as an `Error`.
 *
 * Accepts: `value` — declared `Error` because callers narrow a catch clause
 * with `toError(error as Error)`, but anything can be thrown in JavaScript:
 * a string, `undefined`, a plain object, a `BigInt`, a symbol.
 *
 * Returns: the value itself when it is error-shaped — an object carrying a
 * string `message`, which keeps an SDK error's own fields and `cause` intact;
 * otherwise a fresh `Error` describing what was thrown.
 *
 * Throws: **nothing**. This runs inside `catch` blocks, so a throw here would
 * discard the failure being reported and replace it with its own.
 */
export function toError(value: Error): Error {
  if (value !== null && typeof value === 'object' && typeof value.message === 'string') {
    return value;
  }
  return new Error(describeThrown(value));
}
