import { DEFAULT_RETRYABLE_ERRORS, isRetryableError } from '../../dynamodb/retry-classifier';

/**
 * Transient S3 signals: everything the DynamoDB classifier already treats as
 * transient (the SDK transport `TimeoutError`, socket errors, `RequestTimeout`,
 * `ServiceUnavailable`, …) plus the three names only S3 uses. HTTP 429/5xx and
 * the `$retryable` trait are recognised by the shared classifier itself.
 *
 * `ConditionalRequestConflict` is S3's `409` on a conditional write whose key
 * was deleted between the check and the write; the S3 User Guide's own remedy
 * for it on `PutObject` is to retry the upload (*How to prevent object
 * overwrites with conditional writes*, "Conditional write behavior").
 */
const RETRYABLE_S3_SIGNALS: readonly string[] = [
  ...DEFAULT_RETRYABLE_ERRORS,
  'SlowDown',
  'InternalError',
  'ConditionalRequestConflict',
];

/**
 * Whether `error` is a transient S3 failure worth retrying.
 *
 * Accepts: `error` — any error, including one carrying no name or code, and
 * equally anything else a `throw` can produce.
 *
 * Returns: true for the signals listed above and for anything the shared
 * classifier recognises (HTTP 429/5xx, the SDK's `$retryable` trait, socket
 * errors); false for everything else, so a permission or validation failure is
 * reported on the first attempt — and a value carrying no signal at all is
 * reported rather than retried.
 *
 * Throws: **nothing**, for any value; {@link isRetryableError} is total and
 * this adds nothing to it but a longer signal list.
 */
export function isTransientS3Error(error: Error): boolean {
  return isRetryableError(error, RETRYABLE_S3_SIGNALS);
}
