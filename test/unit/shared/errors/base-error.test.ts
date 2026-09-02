import {
  DynamoDBLangGraphError,
  isDynamoDBLangGraphError,
} from '../../../../src/shared/errors/base-error';
import { ErrorCode } from '../../../../src/shared/errors/error-code';

describe('DynamoDBLangGraphError', () => {
  it('carries code, context, and a native cause chain', () => {
    const cause = new Error('boom');
    const err = new DynamoDBLangGraphError(
      'failed',
      ErrorCode.VALIDATION,
      { operation: 'put' },
      cause,
    );
    expect(err.message).toBe('failed');
    expect(err.code).toBe(ErrorCode.VALIDATION);
    expect(err.context).toEqual({ operation: 'put' });
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('DynamoDBLangGraphError');
  });

  it('defaults context to an empty object and cause to undefined', () => {
    const err = new DynamoDBLangGraphError('x', ErrorCode.CONDITION_CONFLICT);
    expect(err.context).toEqual({});
    expect(err.cause).toBeUndefined();
  });
});

describe('isDynamoDBLangGraphError', () => {
  it('recognizes our errors by brand, not instanceof', () => {
    const ours = new DynamoDBLangGraphError('x', ErrorCode.ABORTED);
    expect(isDynamoDBLangGraphError(ours)).toBe(true);
    expect(isDynamoDBLangGraphError(new Error('plain'))).toBe(false);
  });
});
