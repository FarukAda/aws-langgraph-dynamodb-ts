import {
  DynamoDbLangGraphError,
  isDynamoDbLangGraphError,
} from '../../../../src/shared/errors/base-error';
import { ErrorCode } from '../../../../src/shared/errors/error-code';

describe('DynamoDbLangGraphError', () => {
  it('carries code, context, and a native cause chain', () => {
    const cause = new Error('boom');
    const err = new DynamoDbLangGraphError(
      'failed',
      ErrorCode.VALIDATION,
      { operation: 'put' },
      cause,
    );
    expect(err.message).toBe('failed');
    expect(err.code).toBe(ErrorCode.VALIDATION);
    expect(err.context).toEqual({ operation: 'put' });
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('DynamoDbLangGraphError');
  });

  it('defaults context to an empty object and cause to undefined', () => {
    const err = new DynamoDbLangGraphError('x', ErrorCode.NOT_FOUND);
    expect(err.context).toEqual({});
    expect(err.cause).toBeUndefined();
  });
});

describe('isDynamoDbLangGraphError', () => {
  it('recognizes our errors by brand, not instanceof', () => {
    const ours = new DynamoDbLangGraphError('x', ErrorCode.ABORTED);
    expect(isDynamoDbLangGraphError(ours)).toBe(true);
    expect(isDynamoDbLangGraphError(new Error('plain'))).toBe(false);
  });
});
