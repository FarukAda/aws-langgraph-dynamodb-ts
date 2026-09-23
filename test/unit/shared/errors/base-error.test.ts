import type { WriteRequest } from '../../../../src/shared/dynamodb/types';
import {
  DynamoDBLangGraphError,
  hasErrorCode,
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

describe('details', () => {
  it('is absent, not undefined-valued, when a code carries none', () => {
    const error = new DynamoDBLangGraphError('m', ErrorCode.VALIDATION);
    expect(Object.hasOwn(error, 'details')).toBe(false);
    expect(Object.keys(JSON.parse(JSON.stringify(error)))).not.toContain('details');
  });

  it('copies every array it holds, so a reused buffer cannot rewrite the report', () => {
    const unprocessed: WriteRequest[] = [{ DeleteRequest: { Key: { PK: 'a', SK: 'b' } } }];
    const error = new DynamoDBLangGraphError('m', ErrorCode.BATCH_WRITE_INCOMPLETE, {}, undefined, {
      kind: 'drain',
      succeededCount: 0,
      unprocessed,
      retries: 1,
    });
    unprocessed.push({ DeleteRequest: { Key: { PK: 'c', SK: 'd' } } });
    expect(error.details.kind === 'drain' && error.details.unprocessed).toHaveLength(1);
  });

  it('does not throw for details that are not an object, whatever a JavaScript caller passes', () => {
    const build = (): DynamoDBLangGraphError =>
      new DynamoDBLangGraphError('m', ErrorCode.COMPENSATION_FAILED, {}, undefined, null as never);
    expect(build).not.toThrow();
    expect(build().details).toBeNull();
  });
});

describe('hasErrorCode', () => {
  it('answers true only for a branded error carrying that code', () => {
    const conflict = new DynamoDBLangGraphError('m', ErrorCode.CONDITION_CONFLICT);
    expect(hasErrorCode(conflict, ErrorCode.CONDITION_CONFLICT)).toBe(true);
    expect(hasErrorCode(conflict, ErrorCode.VALIDATION)).toBe(false);
    expect(
      hasErrorCode(
        Object.assign(new Error('x'), { code: 'CONDITION_CONFLICT' }),
        ErrorCode.CONDITION_CONFLICT,
      ),
    ).toBe(false);
  });

  it.each([null, undefined, 'x', 1])('answers false for %p rather than throwing', (value) => {
    expect(hasErrorCode(value as never, ErrorCode.VALIDATION)).toBe(false);
  });
});
