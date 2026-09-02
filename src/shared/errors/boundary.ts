import { isDynamoDBLangGraphError } from './base-error';
import { UpstreamError } from './upstream-error';
import { toError } from './wrap-error';

/**
 * Normalise anything escaping a public method into the library's error model:
 * a branded library error is returned unchanged (its code was assigned closer
 * to the failure and wins), anything else becomes an {@link UpstreamError}.
 */
export function toPublicError(error: Error, operation: string): Error {
  const normalized = toError(error);
  return isDynamoDBLangGraphError(normalized)
    ? normalized
    : new UpstreamError(normalized, operation);
}

/**
 * Run a public operation so that every rejection is a library error. Applied
 * once, at each adapter class method, so internal code can keep rethrowing SDK
 * errors verbatim (the retry classifier depends on their shape).
 */
export async function guardPublic<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    throw toPublicError(error as Error, operation);
  }
}

/**
 * The same guard for a streaming result: items pass through, a failure raised
 * mid-iteration is wrapped, and a consumer that stops early still closes the
 * source generator.
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
