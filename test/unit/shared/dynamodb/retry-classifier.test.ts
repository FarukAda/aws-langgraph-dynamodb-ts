import { isRetryableError } from '../../../../src/shared/dynamodb/retry';
import { DEFAULT_RETRYABLE_ERRORS } from '../../../../src/shared/errors/classify';

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

  it('treats a cancellation carrying an empty reasons array as non-retryable', () => {
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

describe('isRetryableError parity with the SDK classifier', () => {
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

  /**
   * `RequestLimitExceeded` is what an account over its table-count or
   * control-plane rate gets, and `ProvisionedThroughputExceededException` what
   * a provisioned table gets: both are the front door refusing a request that
   * was never served, so both are retried like the `ThrottlingException` they
   * sit beside.
   */
  it('retries every name DynamoDB uses to refuse a request at the front door', () => {
    for (const name of [
      'RequestLimitExceeded',
      'ProvisionedThroughputExceededException',
      'ThrottlingException',
    ]) {
      expect(
        isRetryableError(Object.assign(new Error('slow down'), { name }), DEFAULT_RETRYABLE_ERRORS),
      ).toBe(true);
    }
  });

  /** The service failed the request itself, which says nothing about the request. */
  it('retries the service-side failures', () => {
    for (const name of ['InternalServerError', 'ServiceUnavailable']) {
      expect(
        isRetryableError(Object.assign(new Error('boom'), { name }), DEFAULT_RETRYABLE_ERRORS),
      ).toBe(true);
    }
  });

  /**
   * `EAI_AGAIN` is a temporary DNS resolution failure and `ECONNREFUSED` a
   * connection the far end turned away; both arrive as a `code`. Neither request
   * reached the service, so neither can have been applied. The list once held
   * `NetworkingError` for this case, but that is an SDK v2 name no v3 package
   * emits: a v3 connection failure carries the Node system `code` instead.
   */
  it('retries a connection that never formed', () => {
    expect(
      isRetryableError(
        Object.assign(new Error('getaddrinfo'), { code: 'EAI_AGAIN' }),
        DEFAULT_RETRYABLE_ERRORS,
      ),
    ).toBe(true);
    expect(
      isRetryableError(
        Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
        DEFAULT_RETRYABLE_ERRORS,
      ),
    ).toBe(true);
  });

  /**
   * The cases above name the entries a reader should be able to find by
   * searching for them. This one closes the list as a whole: every token in it
   * is matched through each of the four fields the classifier reads, so an
   * entry added later cannot sit in the contract with nothing exercising it —
   * which is how `RequestLimitExceeded` and `EAI_AGAIN` came to be untested.
   */
  it('retries every entry of the list through each field the classifier reads', () => {
    for (const signal of DEFAULT_RETRYABLE_ERRORS) {
      for (const field of ['name', 'code', 'errno', 'syscall'] as const) {
        const error = Object.assign(new Error(signal), { [field]: signal });
        expect(isRetryableError(error, DEFAULT_RETRYABLE_ERRORS)).toBe(true);
      }
    }
  });
});

/**
 * Every failure the default tokens retried before they were derived from the
 * classifier's table is still retried. The transport failures matter most: a
 * timeout, a reset or refused connection, a failed DNS lookup and the SDK's own
 * transient markers are what a flaky network produces, and losing one would
 * turn a blip into a failed write.
 */
describe('the default tokens keep everything they retried before', () => {
  const PREVIOUSLY_RETRIED_NAMES = [
    'ProvisionedThroughputExceededException',
    'ThrottlingException',
    'RequestLimitExceeded',
    'InternalServerError',
    'ServiceUnavailable',
    'TransactionConflictException',
    'TransactionInProgressException',
    'RequestTimeout',
    'RequestTimeoutException',
    'TimeoutError',
  ];
  const PREVIOUSLY_RETRIED_CODES = [
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
  ];

  it.each(PREVIOUSLY_RETRIED_NAMES)('retries the name %s', (name) => {
    expect(
      isRetryableError(Object.assign(new Error(name), { name }), DEFAULT_RETRYABLE_ERRORS),
    ).toBe(true);
  });

  it.each(PREVIOUSLY_RETRIED_CODES)(
    'retries the network code %s through code, errno and syscall',
    (code) => {
      for (const field of ['code', 'errno', 'syscall'] as const) {
        const error = new Error('outer', {
          cause: Object.assign(new Error(code), { [field]: code }),
        });
        expect(isRetryableError(error, DEFAULT_RETRYABLE_ERRORS)).toBe(true);
      }
    },
  );

  it('retries the SDK transient markers and statuses whatever the name', () => {
    expect(
      isRetryableError(
        Object.assign(new Error('x'), { name: 'Unknown', $retryable: {} }),
        DEFAULT_RETRYABLE_ERRORS,
      ),
    ).toBe(true);
    for (const status of [429, 500, 502, 503, 504]) {
      expect(
        isRetryableError(
          Object.assign(new Error('x'), { name: 'Unknown', $metadata: { httpStatusCode: status } }),
          DEFAULT_RETRYABLE_ERRORS,
        ),
      ).toBe(true);
    }
  });

  it('retries a cancellation whose every reason is transient', () => {
    for (const code of [
      'TransactionConflict',
      'ThrottlingError',
      'ProvisionedThroughputExceeded',
    ]) {
      const error = Object.assign(new Error('cancelled'), {
        name: 'TransactionCanceledException',
        CancellationReasons: [{ Code: 'None' }, { Code: code }],
      });
      expect(isRetryableError(error, DEFAULT_RETRYABLE_ERRORS)).toBe(true);
    }
  });

  /**
   * The derived list adds `InternalFailure` and `ReplicatedWriteConflictException`
   * (both documented as safe to retry), and for DynamoDB the three S3 names it
   * now shares with the S3 path.
   */
  it('also retries the names the derived list adds', () => {
    for (const name of [
      'InternalFailure',
      'ReplicatedWriteConflictException',
      'SlowDown',
      'InternalError',
      'ConditionalRequestConflict',
    ]) {
      expect(
        isRetryableError(Object.assign(new Error(name), { name }), DEFAULT_RETRYABLE_ERRORS),
      ).toBe(true);
    }
  });
});
