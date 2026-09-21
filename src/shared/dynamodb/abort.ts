import { isDynamoDBLangGraphError } from '../errors/base-error';
import { ErrorCode } from '../errors/error-code';
import { AbortError } from '../errors/errors';
import { toError } from '../errors/wrap-error';

/** True when the abort reason already is this library's `AbortError` (a string or DOMException is not). */
function isLibraryAbort(reason: Error | undefined): reason is AbortError {
  return (
    typeof reason === 'object' &&
    reason !== null &&
    isDynamoDBLangGraphError(reason) &&
    reason.code === ErrorCode.ABORTED
  );
}

/**
 * Whether `error` is a cancellation rather than a failure.
 *
 * Accepts: `error` — any error, from any layer.
 *
 * Returns: whether it carries `code: 'ABORTED'`, which is the contract every
 * cancellable method documents and the only thing a caller branches on. It is
 * deliberately weaker than {@link isLibraryAbort}: that one decides whether a
 * value may be *returned* as an `AbortError`, so it must also be branded,
 * while this one only decides whether an error a wrapper caught is the
 * caller's own stop and must be re-thrown as it is.
 *
 * Throws: nothing.
 */
export function isAbortError(error: Error): boolean {
  return (error as { code?: string }).code === ErrorCode.ABORTED;
}

/**
 * This library's error for an aborted `signal`.
 *
 * Accepts: `signal` — aborted; its `reason` may be this library's own
 * `AbortError`, the `DOMException` a bare `controller.abort()` produces, a
 * string, any other error, or `undefined`.
 *
 * Returns: the reason unchanged when it already is this library's `AbortError`,
 * so an error does not accumulate wrappers across layers; otherwise a fresh
 * `AbortError` carrying the reason as `cause` (`undefined` reason carries
 * none).
 *
 * Throws: nothing.
 *
 * Guarantees: `code === 'ABORTED'` holds however the signal was aborted, so a
 * caller branches on the code rather than on the reason's shape.
 */
export function abortErrorFrom(signal: AbortSignal): AbortError {
  const reason = signal.reason as Error | undefined;
  if (isLibraryAbort(reason)) return reason;
  return new AbortError('Operation aborted', reason === undefined ? undefined : toError(reason));
}
