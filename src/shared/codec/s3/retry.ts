import { DEFAULT_RETRYABLE_ERRORS, isRetryableError } from '../../dynamodb/retry-classifier';

/**
 * Transient S3 signals: everything the DynamoDB classifier already treats as
 * transient (the SDK transport `TimeoutError`, socket errors, `RequestTimeout`,
 * `ServiceUnavailable`, …) plus the two names only S3 uses.
 */
const RETRYABLE_S3_SIGNALS: readonly string[] = [
  ...DEFAULT_RETRYABLE_ERRORS,
  'SlowDown',
  'InternalError',
];

const MAX_CAUSE_DEPTH = 32;

/** The first HTTP status carried by `error` or a cause in its chain, if any. */
function httpStatusOf(error: Error): number | undefined {
  let node: Error | undefined = error;
  for (let depth = 0; node !== undefined && depth <= MAX_CAUSE_DEPTH; depth++) {
    const status = (node as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (typeof status === 'number') return status;
    node = (node as { cause?: Error }).cause;
  }
  return undefined;
}

/**
 * True when `error` looks like a transient S3 failure worth retrying: a 429 or
 * 5xx status on the error or any cause (S3 names a bodiless 5xx by its status
 * alone, so the status check is what catches those), or a transient signal in
 * {@link RETRYABLE_S3_SIGNALS} anywhere in the cause chain. The one classifier
 * for uploads, downloads and orphan cleanup.
 */
export function isTransientS3Error(error: Error): boolean {
  const status = httpStatusOf(error);
  if (status !== undefined && (status === 429 || (status >= 500 && status < 600))) return true;
  return isRetryableError(error, RETRYABLE_S3_SIGNALS);
}
