import { DEFAULT_RETRYABLE_ERRORS, isRetryableError } from '../../dynamodb/retry-classifier';

/**
 * Transient S3 signals: everything the DynamoDB classifier already treats as
 * transient (the SDK transport `TimeoutError`, socket errors, `RequestTimeout`,
 * `ServiceUnavailable`, …) plus the two names only S3 uses. HTTP 429/5xx and
 * the `$retryable` trait are recognised by the shared classifier itself.
 */
const RETRYABLE_S3_SIGNALS: readonly string[] = [
  ...DEFAULT_RETRYABLE_ERRORS,
  'SlowDown',
  'InternalError',
];

/**
 * True when `error` looks like a transient S3 failure worth retrying — the one
 * classifier for uploads, downloads and orphan cleanup.
 */
export function isTransientS3Error(error: Error): boolean {
  return isRetryableError(error, RETRYABLE_S3_SIGNALS);
}
