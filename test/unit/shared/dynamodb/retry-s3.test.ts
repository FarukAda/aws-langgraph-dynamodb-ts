import { isTransientS3Error } from '../../../../src/shared/dynamodb/retry';

const withStatus = (status: number, name: string): Error =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });

describe('isTransientS3Error', () => {
  it('treats 429 and 5xx statuses as transient and 4xx as permanent', () => {
    expect(isTransientS3Error(withStatus(429, 'SlowDown'))).toBe(true);
    expect(isTransientS3Error(withStatus(503, '503'))).toBe(true);
    expect(isTransientS3Error(withStatus(403, 'AccessDenied'))).toBe(false);
    expect(isTransientS3Error(withStatus(404, 'NoSuchKey'))).toBe(false);
  });

  it('recognises the SDK transport timeout and socket errors, not just S3 error names', () => {
    expect(isTransientS3Error(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe(true);
    expect(isTransientS3Error(Object.assign(new Error('r'), { code: 'ECONNREFUSED' }))).toBe(true);
    expect(isTransientS3Error(Object.assign(new Error('i'), { name: 'InternalError' }))).toBe(true);
    expect(isTransientS3Error(new Error('plain'))).toBe(false);
  });

  /**
   * The third S3-only name, and the one with a behaviour behind it: S3 answers
   * a conditional `PutObject` whose key was deleted between the check and the
   * write with a `409`, and the User Guide's own remedy is to retry the
   * upload. Named in the list and asserted nowhere, it could have been deleted
   * without a single test noticing — and the conditional write every offloaded
   * payload goes out under is exactly what produces it. The 409 is pinned by
   * name alone, without a status, because that is how the SDK models it.
   */
  it('retries the conditional-write conflict S3 answers a raced key with', () => {
    const named = Object.assign(new Error('conflict'), { name: 'ConditionalRequestConflict' });
    expect(isTransientS3Error(named)).toBe(true);
    expect(isTransientS3Error(withStatus(409, 'ConditionalRequestConflict'))).toBe(true);
    expect(isTransientS3Error(withStatus(412, 'PreconditionFailed'))).toBe(false);
  });

  it('looks through the cause chain for a status or a signal', () => {
    expect(
      isTransientS3Error(new Error('wrapped', { cause: withStatus(500, 'InternalError') })),
    ).toBe(true);
    const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
    const deep = new Error('outer', { cause: new Error('inner', { cause: timeout }) });
    expect(isTransientS3Error(deep)).toBe(true);
  });

  it('survives a cyclic cause chain', () => {
    const loop = new Error('loop') as Error & { cause?: Error };
    loop.cause = loop;
    expect(isTransientS3Error(loop)).toBe(false);
  });

  it('retries an error the SDK marks retryable by trait', () => {
    const err = Object.assign(new Error('x'), { name: 'Unknown', $retryable: {} });
    expect(isTransientS3Error(err)).toBe(true);
  });

  it('retries a nested cause carrying a network errno or syscall code', () => {
    const byErrno = new Error('outer', {
      cause: Object.assign(new Error('reset'), { errno: 'ECONNRESET' }),
    });
    expect(isTransientS3Error(byErrno)).toBe(true);
    const bySyscall = new Error('outer', {
      cause: Object.assign(new Error('pipe'), { syscall: 'EPIPE' }),
    });
    expect(isTransientS3Error(bySyscall)).toBe(true);
  });
});

/**
 * S3 once kept a list of its own: the DynamoDB tokens plus three S3 names. It
 * now uses the one shared list, and every name and network code the old list
 * held is still retried on the S3 path.
 */
describe('isTransientS3Error keeps everything it retried before', () => {
  it.each([
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
    'SlowDown',
    'InternalError',
    'ConditionalRequestConflict',
  ])('retries the name %s', (name) => {
    expect(isTransientS3Error(Object.assign(new Error(name), { name }))).toBe(true);
  });

  it.each([
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'EPIPE',
    'EAI_AGAIN',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
  ])('retries the network code %s', (code) => {
    expect(isTransientS3Error(Object.assign(new Error(code), { code }))).toBe(true);
  });
});
