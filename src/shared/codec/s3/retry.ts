import { isRetryableError } from '../../dynamodb/retry-classifier';
import { DEFAULT_RETRYABLE_ERRORS } from '../../errors/classify';

/**
 * Whether `error` is a transient S3 failure worth retrying.
 *
 * Accepts: `error` — any error, including one carrying no name or code, and
 * equally anything else a `throw` can produce.
 *
 * Returns: {@link isRetryableError} over the shared default tokens, which hold
 * S3's own transient names (`SlowDown`, `InternalError`,
 * `ConditionalRequestConflict`) alongside DynamoDB's — one list, so the two
 * services cannot drift apart on what is transient.
 *
 * Throws: **nothing**, for any value; {@link isRetryableError} is total.
 */
export function isTransientS3Error(error: Error): boolean {
  return isRetryableError(error, DEFAULT_RETRYABLE_ERRORS);
}
