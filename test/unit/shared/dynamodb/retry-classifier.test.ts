import {
  DEFAULT_RETRYABLE_ERRORS,
  isRetryableError,
} from '../../../../src/shared/dynamodb/retry-classifier';

describe('isRetryableError', () => {
  it('matches by name', () => {
    const err = Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    expect(isRetryableError(err, DEFAULT_RETRYABLE_ERRORS)).toBe(true);
  });

  it('matches a Node socket code on a nested cause', () => {
    const inner = Object.assign(new Error('reset'), { code: 'ECONNRESET' });
    const outer = new Error('wrapper', { cause: inner });
    expect(isRetryableError(outer, DEFAULT_RETRYABLE_ERRORS)).toBe(true);
  });

  it('does not match a permanent error', () => {
    const err = Object.assign(new Error('bad'), { name: 'ValidationException' });
    expect(isRetryableError(err, DEFAULT_RETRYABLE_ERRORS)).toBe(false);
  });

  it('does not match TransactionCanceledException but does match TransactionConflictException', () => {
    expect(
      isRetryableError(
        Object.assign(new Error(), { name: 'TransactionCanceledException' }),
        DEFAULT_RETRYABLE_ERRORS,
      ),
    ).toBe(false);
    expect(
      isRetryableError(
        Object.assign(new Error(), { name: 'TransactionConflictException' }),
        DEFAULT_RETRYABLE_ERRORS,
      ),
    ).toBe(true);
  });

  it('retries a transaction cancellation when every reason is transient', () => {
    const err = Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'None' }],
    });
    expect(isRetryableError(err, DEFAULT_RETRYABLE_ERRORS)).toBe(true);
  });

  it('does not retry a transaction cancellation with a permanent reason', () => {
    const err = Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'TransactionConflict' }, { Code: 'ValidationError' }],
    });
    expect(isRetryableError(err, DEFAULT_RETRYABLE_ERRORS)).toBe(false);
  });

  it('matches via the errno and syscall signal fields', () => {
    expect(
      isRetryableError(
        Object.assign(new Error('io'), { errno: 'ETIMEDOUT' }),
        DEFAULT_RETRYABLE_ERRORS,
      ),
    ).toBe(true);
    expect(
      isRetryableError(
        Object.assign(new Error('io'), { syscall: 'EPIPE' }),
        DEFAULT_RETRYABLE_ERRORS,
      ),
    ).toBe(true);
  });

  it('stops walking the cause chain past the maximum depth', () => {
    let node = Object.assign(new Error('deepest'), { code: 'ECONNRESET' });
    for (let i = 0; i < 40; i++) {
      node = new Error(`level ${i}`, { cause: node }) as typeof node;
    }
    expect(isRetryableError(node, DEFAULT_RETRYABLE_ERRORS)).toBe(false);
  });

  it('breaks on a cyclic cause chain without matching', () => {
    const cyclic = new Error('loop') as Error & { cause?: Error };
    cyclic.cause = cyclic;
    expect(isRetryableError(cyclic, DEFAULT_RETRYABLE_ERRORS)).toBe(false);
  });

  it('retries TransactionInProgressException (a re-sent idempotent commit whose original is still in flight)', () => {
    const err = Object.assign(new Error('in progress'), { name: 'TransactionInProgressException' });
    expect(isRetryableError(err, DEFAULT_RETRYABLE_ERRORS)).toBe(true);
  });

  it('retries RequestTimeout and RequestTimeoutException', () => {
    expect(
      isRetryableError(
        Object.assign(new Error('timeout'), { name: 'RequestTimeout' }),
        DEFAULT_RETRYABLE_ERRORS,
      ),
    ).toBe(true);
    expect(
      isRetryableError(
        Object.assign(new Error('timeout'), { name: 'RequestTimeoutException' }),
        DEFAULT_RETRYABLE_ERRORS,
      ),
    ).toBe(true);
  });
});
