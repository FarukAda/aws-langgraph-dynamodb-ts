/**
 * Retry utilities for handling transient DynamoDB errors
 * Shared between store and checkpointer
 */

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableErrors?: string[];
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
  retryableErrors: [
    'ProvisionedThroughputExceededException',
    'ThrottlingException',
    'RequestLimitExceeded',
    'InternalServerError',
    'ServiceUnavailable',
  ],
};

/**
 * Sleep for a specified number of milliseconds
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateDelay(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const exponentialDelay = baseDelayMs * Math.pow(2, attempt - 1);
  const jitter = Math.random() * 0.3 * exponentialDelay; // Add up to 30% jitter
  return Math.min(exponentialDelay + jitter, maxDelayMs);
}

/**
 * Check if an error is retryable
 */
function isRetryableError(error: any, retryableErrors: string[]): boolean {
  if (!error) return false;

  const errorName = error.name || error.code || '';
  return retryableErrors.some((retryable) => errorName.includes(retryable));
}

/**
 * Retry a function with exponential backoff
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: any;

  for (let attempt = 1; attempt <= opts.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      // Don't retry if this is the last attempt
      if (attempt === opts.maxAttempts) {
        break;
      }

      // Don't retry if the error is not retryable
      if (!isRetryableError(error, opts.retryableErrors)) {
        // Convert to Error if needed, preserving properties
        if (error instanceof Error) {
          throw error;
        }
        const wrappedError = new Error((error as any)?.message || String(error));
        // Preserve name and other properties from the original error
        if (error && typeof error === 'object') {
          Object.assign(wrappedError, error);
        }
        throw wrappedError;
      }

      // Calculate delay and wait
      const delay = calculateDelay(attempt, opts.baseDelayMs, opts.maxDelayMs);
      await sleep(delay);
    }
  }

  // Ensure we always throw an Error object
  if (!lastError) {
    throw new Error('Retry failed without error');
  }
  if (lastError instanceof Error) {
    throw lastError;
  }
  // Convert to Error while preserving properties
  const wrappedError = new Error((lastError as any)?.message || String(lastError));
  if (lastError && typeof lastError === 'object') {
    Object.assign(wrappedError, lastError);
  }
  throw wrappedError;
}

/**
 * Specialized retry for DynamoDB operations
 */
export async function withDynamoDBRetry<T>(fn: () => Promise<T>): Promise<T> {
  return withRetry(fn, {
    maxAttempts: 3,
    baseDelayMs: 100,
    maxDelayMs: 5000,
  });
}
