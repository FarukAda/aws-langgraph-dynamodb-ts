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
 * The library's error for an aborted `signal`. A caller's own `AbortError`
 * used as the abort reason is returned unchanged; anything else — the
 * `DOMException` a bare `controller.abort()` produces, a string, a custom
 * error — becomes the `cause` of a fresh {@link AbortError}, so
 * `code === 'ABORTED'` holds however the signal was aborted.
 */
export function abortErrorFrom(signal: AbortSignal): AbortError {
  const reason = signal.reason as Error | undefined;
  if (isLibraryAbort(reason)) return reason;
  return new AbortError('Operation aborted', reason === undefined ? undefined : toError(reason));
}
