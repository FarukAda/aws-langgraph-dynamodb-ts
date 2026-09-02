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

  it('treats a cancellation carrying an empty reasons array as non-retryable (M3)', () => {
    // `.every()` on an empty array is vacuously true, which contradicted the
    // documented "a bare cancellation with no reasons is not retryable".
    const err = Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [],
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

describe('isRetryableError parity with the SDK classifier (DDB-02)', () => {
  const withStatus = (name: string, status: number): Error =>
    Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

  it('retries an unmodeled 5xx and a 429 by status alone', () => {
    for (const status of [500, 502, 503, 504, 429]) {
      expect(isRetryableError(withStatus('Unknown', status), DEFAULT_RETRYABLE_ERRORS)).toBe(true);
    }
  });

  it('retries an error the SDK marks retryable by trait', () => {
    const err = Object.assign(new Error('replicated'), {
      name: 'ReplicatedWriteConflictException',
      $retryable: {},
    });
    expect(isRetryableError(err, DEFAULT_RETRYABLE_ERRORS)).toBe(true);
  });

  it('retries the remaining Node network codes the SDK treats as transient', () => {
    for (const code of ['EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND']) {
      expect(
        isRetryableError(Object.assign(new Error(code), { code }), DEFAULT_RETRYABLE_ERRORS),
      ).toBe(true);
    }
  });

  it('finds a transient status two causes deep', () => {
    const deep = new Error('outer', {
      cause: new Error('middle', { cause: withStatus('Unknown', 500) }),
    });
    expect(isRetryableError(deep, DEFAULT_RETRYABLE_ERRORS)).toBe(true);
  });

  it('does not retry a permanent 4xx even when it carries a status', () => {
    for (const name of [
      'ConditionalCheckFailedException',
      'ResourceNotFoundException',
      'AccessDeniedException',
      'ValidationException',
    ]) {
      expect(isRetryableError(withStatus(name, 400), DEFAULT_RETRYABLE_ERRORS)).toBe(false);
    }
  });

  it('keeps the cancellation verdict ahead of the status and trait rules', () => {
    const permanent = Object.assign(new Error('cancelled'), {
      name: 'TransactionCanceledException',
      CancellationReasons: [{ Code: 'ConditionalCheckFailed' }],
      $metadata: { httpStatusCode: 500 },
      $retryable: {},
    });
    expect(isRetryableError(permanent, DEFAULT_RETRYABLE_ERRORS)).toBe(false);
  });

  it('matches names exactly, not as substrings', () => {
    for (const name of ['ThrottlingExceptionX', 'NotAThrottlingException']) {
      expect(
        isRetryableError(Object.assign(new Error('x'), { name }), DEFAULT_RETRYABLE_ERRORS),
      ).toBe(false);
    }
  });
});
