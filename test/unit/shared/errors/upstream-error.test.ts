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
