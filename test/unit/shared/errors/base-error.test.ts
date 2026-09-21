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

/**
 * The guard is documented as throwing nothing and README recommends calling it
 * from inside a `catch`, which is exactly where the value's type is unknown: a
 * guard that throws there replaces the failure the caller was reporting with a
 * `TypeError` of its own.
 */
describe('isDynamoDBLangGraphError on a value that is not an object', () => {
  const NON_OBJECTS = [null, undefined, 'x', 1, true, Symbol('s'), 10n] as never[];

  it.each(NON_OBJECTS)('answers false for %p instead of throwing', (value) => {
    expect(isDynamoDBLangGraphError(value)).toBe(false);
  });
});

describe('DynamoDBLangGraphError.context is the error own copy', () => {
  /**
   * The context reaches a log line and a caller branch long after the throw.
   * Holding the caller's object by reference let a caller that reuses one
   * builder object rewrite the field of an error already in flight.
   */
  it('does not change when the object the caller passed is mutated afterwards', () => {
    const context = { field: 'tableName' };
    const error = new DynamoDBLangGraphError('x', ErrorCode.VALIDATION, context);
    context.field = 'changed';
    expect(error.context.field).toBe('tableName');
  });

  it('treats a null context as an absent one rather than storing it', () => {
    expect(new DynamoDBLangGraphError('x', ErrorCode.VALIDATION, null as never).context).toEqual(
      {},
    );
  });
});
