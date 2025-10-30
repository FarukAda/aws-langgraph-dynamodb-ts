/**
 * Result type for better error handling
 * Allows functions to return either a success value or an error
 */
export type Result<T, E = Error> = { success: true; data: T } | { success: false; error: E };

/**
 * Create a successful result
 */
export function Ok<T>(data: T): Result<T, never> {
  return { success: true, data };
}

/**
 * Create an error result
 */
export function Err<E = Error>(error: E): Result<never, E> {
  return { success: false, error };
}

/**
 * Check if a result is successful
 */
export function isOk<T, E>(result: Result<T, E>): result is { success: true; data: T } {
  return result.success === true;
}

/**
 * Check if a result is an error
 */
export function isErr<T, E>(result: Result<T, E>): result is { success: false; error: E } {
  return result.success === false;
}

/**
 * Unwrap a result or throw if it's an error
 */
export function unwrap<T, E>(result: Result<T, E>): T {
  if (isOk(result)) {
    return result.data;
  }
  throw result.error;
}

/**
 * Unwrap a result or return a default value if it's an error
 */
export function unwrapOr<T, E>(result: Result<T, E>, defaultValue: T): T {
  if (isOk(result)) {
    return result.data;
  }
  return defaultValue;
}
