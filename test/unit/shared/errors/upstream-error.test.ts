import { isDynamoDBLangGraphError } from '../../../../src/shared/errors/base-error';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { UpstreamError } from '../../../../src/shared/errors/upstream-error';

describe('UpstreamError', () => {
  it('wraps an SDK error, keeping its name, request id and HTTP status for support tickets', () => {
    const cause = Object.assign(new Error('The security token is invalid'), {
      name: 'UnrecognizedClientException',
      $metadata: { requestId: 'req-1', httpStatusCode: 400 },
    });
    const error = new UpstreamError(cause, 'saver.put');
    expect(error.name).toBe('UpstreamError');
    expect(error.code).toBe(ErrorCode.UPSTREAM);
    expect(error.message).toBe(
      'saver.put: UnrecognizedClientException: The security token is invalid',
    );
    expect(error.upstreamName).toBe('UnrecognizedClientException');
    expect(error.requestId).toBe('req-1');
    expect(error.httpStatusCode).toBe(400);
    expect(error.cause).toBe(cause);
    expect(error.context).toEqual({ operation: 'saver.put' });
    expect(isDynamoDBLangGraphError(error)).toBe(true);
  });

  it('omits request metadata the cause does not carry', () => {
    const error = new UpstreamError(new TypeError('x'), 'op');
    expect(error.upstreamName).toBe('TypeError');
    expect(error.requestId).toBeUndefined();
    expect(error.httpStatusCode).toBeUndefined();
    expect('requestId' in error).toBe(false);
  });
});

describe('UpstreamError redacts the cause it quotes (SEC-05)', () => {
  /**
   * The wrapped message reaches `err.message`, which an application may print
   * with a plain console call rather than through a redacting logger. An SDK
   * error can carry a credential fragment in its own text, so quoting it raw
   * leaked it through the one path that bypasses the logger entirely.
   */
  it('replaces a credential shape in the quoted message', () => {
    const cause = new Error('SignatureDoesNotMatch: Credential=AKIAIOSFODNN7EXAMPLE/20240101');
    const error = new UpstreamError(cause, 'saver.put');
    expect(error.message).not.toContain('AKIAIOSFODNN7EXAMPLE');
    expect(error.message).toContain('[REDACTED]');
  });

  it('keeps the operation, the upstream name and the cause itself', () => {
    const cause = new Error('throttled');
    const error = new UpstreamError(cause, 'store.put');
    expect(error.message).toBe('store.put: Error: throttled');
    expect(error.upstreamName).toBe('Error');
    expect(error.cause).toBe(cause);
  });
});
