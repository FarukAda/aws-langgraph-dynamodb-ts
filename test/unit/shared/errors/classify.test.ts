import {
  AWS_ERROR_CODES,
  awsDiagnostics,
  classifyAwsError,
  DEFAULT_RETRYABLE_ERRORS,
  isMissingLifecycleConfiguration,
  isMissingObject,
} from '../../../../src/shared/errors/classify';
import { ErrorCode } from '../../../../src/shared/errors/error-code';

/** An error the way the SDK builds one: a name, and `$metadata` from the response. */
function sdkError(
  name: string,
  metadata: object = { httpStatusCode: 400, requestId: 'r-1' },
): Error {
  return Object.assign(new Error('m'), { name, $metadata: metadata });
}

function cancellation(...codes: (string | undefined)[]): Error {
  return Object.assign(sdkError('TransactionCanceledException'), {
    CancellationReasons: codes.map((Code) => (Code === undefined ? {} : { Code })),
  });
}

describe('classifyAwsError', () => {
  it.each([
    ['ProvisionedThroughputExceededException', ErrorCode.THROTTLED],
    ['ThrottlingException', ErrorCode.THROTTLED],
    ['RequestLimitExceeded', ErrorCode.THROTTLED],
    ['SlowDown', ErrorCode.THROTTLED],
    ['InternalServerError', ErrorCode.SERVICE_UNAVAILABLE],
    ['ServiceUnavailable', ErrorCode.SERVICE_UNAVAILABLE],
    ['TimeoutError', ErrorCode.SERVICE_UNAVAILABLE],
    ['TransactionConflictException', ErrorCode.CONTENTION],
    ['ConditionalRequestConflict', ErrorCode.CONTENTION],
    ['AccessDeniedException', ErrorCode.ACCESS_DENIED],
    ['UnrecognizedClientException', ErrorCode.ACCESS_DENIED],
    ['ExpiredTokenException', ErrorCode.ACCESS_DENIED],
    ['ResourceNotFoundException', ErrorCode.NOT_FOUND],
    ['NoSuchKey', ErrorCode.NOT_FOUND],
    ['NoSuchLifecycleConfiguration', ErrorCode.NOT_FOUND],
    ['ValidationException', ErrorCode.AWS_REJECTED],
    ['IdempotentParameterMismatchException', ErrorCode.AWS_REJECTED],
    ['ConditionalCheckFailedException', ErrorCode.CONDITION_CONFLICT],
    ['PreconditionFailed', ErrorCode.CONDITION_CONFLICT],
    ['ItemCollectionSizeLimitExceededException', ErrorCode.AWS_REQUEST_FAILED],
    ['AbortError', ErrorCode.ABORTED],
  ])('maps %s to %s', (name, code) => {
    expect(classifyAwsError(sdkError(name))).toBe(code);
  });

  it('classifies a cancellation by its reasons', () => {
    expect(classifyAwsError(cancellation('None', 'ConditionalCheckFailed'))).toBe(
      ErrorCode.CONDITION_CONFLICT,
    );
    expect(classifyAwsError(cancellation('ThrottlingError', 'None'))).toBe(ErrorCode.THROTTLED);
    expect(classifyAwsError(cancellation('TransactionConflict'))).toBe(ErrorCode.CONTENTION);
    expect(classifyAwsError(cancellation('ValidationError'))).toBe(ErrorCode.AWS_REQUEST_FAILED);
    expect(classifyAwsError(cancellation('ConditionalCheckFailed', 'ConditionalCheckFailed'))).toBe(
      ErrorCode.AWS_REQUEST_FAILED,
    );
    expect(classifyAwsError(sdkError('TransactionCanceledException'))).toBe(
      ErrorCode.AWS_REQUEST_FAILED,
    );
  });

  it('falls back on the network code, then the HTTP status', () => {
    expect(classifyAwsError(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(
      ErrorCode.SERVICE_UNAVAILABLE,
    );
    expect(classifyAwsError(sdkError('Unknown', { httpStatusCode: 412 }))).toBe(
      ErrorCode.CONDITION_CONFLICT,
    );
    expect(classifyAwsError(sdkError('Unknown', { httpStatusCode: 429 }))).toBe(
      ErrorCode.THROTTLED,
    );
    expect(classifyAwsError(sdkError('Unknown', { httpStatusCode: 503 }))).toBe(
      ErrorCode.SERVICE_UNAVAILABLE,
    );
    expect(classifyAwsError(sdkError('Unknown', { httpStatusCode: 418 }))).toBe(
      ErrorCode.AWS_REQUEST_FAILED,
    );
    expect(classifyAwsError(sdkError('Unknown', null as never))).toBe(ErrorCode.UNEXPECTED_ERROR);
  });

  it('calls an undeclared …Exception AWS-shaped, and anything else unexpected', () => {
    expect(classifyAwsError(Object.assign(new Error('x'), { name: 'SomeNewException' }))).toBe(
      ErrorCode.AWS_REQUEST_FAILED,
    );
    expect(classifyAwsError(new TypeError('bug'))).toBe(ErrorCode.UNEXPECTED_ERROR);
  });

  it.each([null, undefined, 'boom', 7, { name: { toString: null } }])(
    'is total: %p yields a code and never throws',
    (value) => {
      expect(Object.values(ErrorCode)).toContain(classifyAwsError(value as never));
    },
  );

  it('does not read a name off the prototype chain of the table', () => {
    expect(classifyAwsError(Object.assign(new Error('x'), { name: 'toString' }))).toBe(
      ErrorCode.UNEXPECTED_ERROR,
    );
  });
});

describe('awsDiagnostics', () => {
  it('lifts the name, request id and status off an AWS-shaped error', () => {
    expect(awsDiagnostics(sdkError('ThrottlingException'))).toEqual({
      awsErrorName: 'ThrottlingException',
      httpStatusCode: 400,
      requestId: 'r-1',
    });
  });

  it('reports nothing for an error that is not AWS-shaped, a bare network failure included', () => {
    expect(awsDiagnostics(new TypeError('bug'))).toEqual({});
    expect(awsDiagnostics(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toEqual({});
    expect(awsDiagnostics(null as never)).toEqual({});
  });

  it('keeps only well-typed metadata', () => {
    expect(
      awsDiagnostics(sdkError('ThrottlingException', { httpStatusCode: '400', requestId: 3 })),
    ).toEqual({
      awsErrorName: 'ThrottlingException',
    });
  });

  it('omits the name when the error carries none, even though $metadata makes it AWS-shaped', () => {
    expect(awsDiagnostics({ $metadata: { httpStatusCode: 500 } } as never)).toEqual({
      httpStatusCode: 500,
    });
  });
});

describe('isMissingObject', () => {
  it('is NoSuchKey and nothing else, so a missing bucket is never a lost payload', () => {
    expect(isMissingObject(sdkError('NoSuchKey'))).toBe(true);
    expect(isMissingObject(sdkError('NoSuchBucket'))).toBe(false);
    expect(isMissingObject(null as never)).toBe(false);
  });
});

describe('isMissingLifecycleConfiguration', () => {
  it('is NoSuchLifecycleConfiguration and no other NOT_FOUND name', () => {
    expect(isMissingLifecycleConfiguration(sdkError('NoSuchLifecycleConfiguration'))).toBe(true);
    for (const name of ['NoSuchBucket', 'ResourceNotFoundException', 'NoSuchKey']) {
      expect(classifyAwsError(sdkError(name))).toBe(ErrorCode.NOT_FOUND);
      expect(isMissingLifecycleConfiguration(sdkError(name))).toBe(false);
    }
    expect(isMissingLifecycleConfiguration(null as never)).toBe(false);
  });
});

describe('DEFAULT_RETRYABLE_ERRORS', () => {
  it('is every name the table calls transient, plus the network codes', () => {
    const transient = Object.entries(AWS_ERROR_CODES)
      .filter(([, code]) =>
        [ErrorCode.THROTTLED, ErrorCode.SERVICE_UNAVAILABLE, ErrorCode.CONTENTION].includes(code),
      )
      .map(([name]) => name);
    expect(DEFAULT_RETRYABLE_ERRORS).toEqual(
      expect.arrayContaining([...transient, 'ECONNRESET', 'EAI_AGAIN']),
    );
    expect(DEFAULT_RETRYABLE_ERRORS).not.toContain('ValidationException');
    expect(DEFAULT_RETRYABLE_ERRORS).not.toContain('NetworkingError');
  });
});
