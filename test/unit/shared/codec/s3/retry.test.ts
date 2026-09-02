import { isTransientS3Error } from '../../../../../src/shared/codec/s3/retry';

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
});
