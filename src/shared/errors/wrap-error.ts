/**
 * Normalize a caught value (TypeScript types catch clauses as the implicit
 * unknown) into an `Error`. Error-shaped values pass through; anything else is
 * stringified into a fresh `Error`. This is the boundary where caught values
 * are narrowed — callers do `toError(error as Error)`.
 */
export function toError(value: Error): Error {
  if (value !== null && typeof value === 'object' && typeof value.message === 'string') {
    return value;
  }
  return new Error(typeof value === 'string' ? value : JSON.stringify(value));
}
