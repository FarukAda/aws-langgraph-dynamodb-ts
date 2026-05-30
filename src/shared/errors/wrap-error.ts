import { DynamoDbLangGraphError, ErrorContext, isDynamoDbLangGraphError } from './base-error';
import { ErrorCode } from './error-code';

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

/**
 * Wrap a raw error in a coded {@link DynamoDbLangGraphError} with structured
 * context, preserving the original as `cause`. Already-coded errors are
 * returned unchanged so codes assigned closer to the failure win.
 */
export function wrapError(
  cause: Error,
  code: ErrorCode,
  context?: ErrorContext,
): DynamoDbLangGraphError {
  const normalized = toError(cause);
  if (isDynamoDbLangGraphError(normalized)) {
    return normalized;
  }
  return new DynamoDbLangGraphError(normalized.message, code, context ?? {}, normalized);
}
