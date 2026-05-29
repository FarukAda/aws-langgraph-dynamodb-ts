const MAX_CAUSE_DEPTH = 32;

/**
 * Default retryable transient signals. TransactionCanceledException is
 * intentionally absent (its reasons include permanent failures);
 * TransactionConflictException (transient row contention) IS retryable.
 */
export const DEFAULT_RETRYABLE_ERRORS: readonly string[] = [
  'ProvisionedThroughputExceededException',
  'ThrottlingException',
  'RequestLimitExceeded',
  'InternalServerError',
  'ServiceUnavailable',
  'TransactionConflictException',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'NetworkingError',
  'TimeoutError',
];

function collectSignals(error: Error): string[] {
  const seen = new WeakSet<object>();
  const signals: string[] = [];
  const walk = (node: Error, depth: number): void => {
    if (depth > MAX_CAUSE_DEPTH || node === null || typeof node !== 'object' || seen.has(node)) {
      return;
    }
    seen.add(node);
    const fields = node as {
      name?: string;
      code?: string;
      errno?: string;
      syscall?: string;
      cause?: Error;
    };
    for (const value of [fields.name, fields.code, fields.errno, fields.syscall]) {
      if (typeof value === 'string') signals.push(value);
    }
    if (fields.cause) walk(fields.cause, depth + 1);
  };
  walk(error, 0);
  return signals;
}

/** True when `error` (or any cause in its chain) matches a retryable signal. */
export function isRetryableError(error: Error, retryableErrors: readonly string[]): boolean {
  const signals = collectSignals(error);
  return signals.some((signal) => retryableErrors.some((retryable) => signal.includes(retryable)));
}
