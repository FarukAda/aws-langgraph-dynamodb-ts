import { isDynamoDBLangGraphError } from './base-error';
import { UpstreamError } from './upstream-error';
import { toError } from './wrap-error';

/**
 * Normalise anything escaping a public method into the library's error model.
 *
 * Accepts: anything a `catch` produced — an `Error`, or a value that is not one
 * (`toError` settles that first).
 *
 * Returns: a branded library error unchanged, since its code was assigned
 * closer to the failure and wins; anything else wrapped as an
 * {@link UpstreamError} naming `operation`.
 *
 * Throws: nothing. It runs inside a `catch`, where throwing would discard the
 * failure being reported and replace it with its own.
 */
export function toPublicError(error: Error, operation: string): Error {
  const normalized = toError(error);
  return isDynamoDBLangGraphError(normalized)
    ? normalized
    : new UpstreamError(normalized, operation);
}

/**
 * Run a public operation so that every rejection is a library error.
 *
 * Accepts: `operation` — the public method's name, which the wrapped error
 * carries. `fn` — the work.
 *
 * Returns: whatever `fn` resolves to, untouched.
 *
 * Throws: a library error, always. Applied once, at each adapter class method,
 * so internal code can keep rethrowing SDK errors verbatim — the retry
 * classifier depends on their shape, and wrapping them early would blind it.
 */
export async function guardPublic<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toPublicError(error as Error, operation);
  }
}

/**
 * The same guard for a streaming result.
 *
 * Accepts: `operation` — the public method's name. `source` — the generator to
 * relay.
 *
 * Returns: a generator yielding the source's items untouched. A consumer that
 * stops early still closes the source, so an abandoned listing stops reading
 * rather than paging on in the background.
 *
 * Throws: a library error, always — including for a failure raised
 * mid-iteration, which is the case a `try` around the loop body would miss.
 */
export async function* guardPublicIterable<T>(
  operation: string,
  source: AsyncGenerator<T>,
): AsyncGenerator<T> {
  try {
    for await (const item of source) yield item;
  } catch (error) {
    throw toPublicError(error as Error, operation);
  }
}
