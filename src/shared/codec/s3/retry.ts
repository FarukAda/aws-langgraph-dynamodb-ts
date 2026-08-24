const RETRYABLE_S3_SIGNALS: readonly string[] = [
  'SlowDown',
  'InternalError',
  'ServiceUnavailable',
  'RequestTimeout',
  'ThrottlingException',
  'ECONNRESET',
  'ETIMEDOUT',
  'NetworkingError',
];

export { RETRYABLE_S3_SIGNALS };

/** True when `error` looks like a transient S3 failure worth retrying. */
export function isTransientS3Error(error: Error): boolean {
  const fields = error as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  const status = fields.$metadata?.httpStatusCode;
  if (typeof status === 'number' && (status === 429 || (status >= 500 && status < 600)))
    return true;
  const signals = [fields.name, fields.code].filter(
    (value): value is string => typeof value === 'string',
  );
  return signals.some((signal) =>
    RETRYABLE_S3_SIGNALS.some((retryable) => signal.includes(retryable)),
  );
}
