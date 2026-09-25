import { DynamoDBLangGraphError, hasErrorCode, toError } from '../errors/base-error';
import { ErrorCode } from '../errors/error-code';
import { abortError } from '../errors/errors';

/**
 * Whether `error` is a cancellation rather than a failure.
 *
 * Accepts: `error` — any error, from any layer, and equally any other value a
 * `throw` can produce, since a `catch` is where this is called; `undefined`
 * too, the `reason` a signal aborted without one can carry.
 *
 * Returns: whether it carries this library's brand and `code: 'ABORTED'`,
 * which is the contract every cancellable method documents and the only thing
 * a caller branches on, narrowed so it can be handed on as the abort it is.
 * An unbranded object that merely carries `code: 'ABORTED'` is not an abort,
 * because an error a wrapper caught that only looks like an abort must still
 * be rebranded rather than re-thrown as it is.
 *
 * Throws: **nothing**, for any value. A value that cannot carry a property is
 * not a cancellation, which is the answer an uncoded `Error` gets too.
 */
export function isAbortError(
  error: Error | undefined,
): error is DynamoDBLangGraphError<ErrorCode.ABORTED> {
  return error !== undefined && hasErrorCode(error, ErrorCode.ABORTED);
}

/**
 * This library's error for an aborted `signal`.
 *
 * Accepts: `signal` — aborted; its `reason` may be this library's own
 * `ABORTED` error, the `DOMException` a bare `controller.abort()` produces, a
 * string, any other error, or `undefined`.
 *
 * Returns: the reason unchanged when it already is this library's own
 * `ABORTED` error, so an error does not accumulate wrappers across layers;
 * otherwise a fresh `ABORTED` error carrying the reason as `cause` (`undefined` reason carries
 * none).
 *
 * Throws: nothing.
 *
 * Guarantees: `code === 'ABORTED'` holds however the signal was aborted, so a
 * caller branches on the code rather than on the reason's shape.
 */
export function abortErrorFrom(signal: AbortSignal): DynamoDBLangGraphError<ErrorCode.ABORTED> {
  const reason = signal.reason as Error | undefined;
  if (isAbortError(reason)) return reason;
  return abortError('Operation aborted', reason === undefined ? undefined : toError(reason));
}
