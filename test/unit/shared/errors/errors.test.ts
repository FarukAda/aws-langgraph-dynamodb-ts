import { ErrorCode } from '../../../../src/shared/errors/error-code';
import {
  AbortError,
  BatchWriteAllIncompleteError,
  BatchWriteIncompleteError,
  CompensationFailedError,
  ConflictError,
  ResultTruncatedError,
  RetryExhaustedError,
  ValidationError,
} from '../../../../src/shared/errors/errors';

describe('error subclasses', () => {
  it('each fixes its ErrorCode', () => {
    expect(new ValidationError('v').code).toBe(ErrorCode.VALIDATION);
    expect(new ConflictError('c').code).toBe(ErrorCode.CONDITION_CONFLICT);
    expect(new RetryExhaustedError('r').code).toBe(ErrorCode.RETRY_EXHAUSTED);
    expect(new AbortError().code).toBe(ErrorCode.ABORTED);
    expect(new ResultTruncatedError('maxItems', 10000).code).toBe(ErrorCode.RESULT_TRUNCATED);
  });

  it('CompensationFailedError carries the trigger as cause and the rollback error', () => {
    const trigger = new Error('append failed');
    const rollback = new Error('delete failed');
    const err = new CompensationFailedError(trigger, rollback);
    expect(err.code).toBe(ErrorCode.COMPENSATION_FAILED);
    expect(err.cause).toBe(trigger);
    expect(err.rollbackError).toBe(rollback);
    expect(err.message).toMatch(/append failed/);
    expect(err.message).toMatch(/delete failed/);
  });

  it('ResultTruncatedError names the cap and limit it hit', () => {
    const err = new ResultTruncatedError('maxIterations', 1000);
    expect(err.message).toMatch(/maxIterations cap \(1000\)/);
    expect(err.context).toEqual({ operation: 'maxIterations' });
  });

  it('BatchWriteIncompleteError keeps succeededCount and unprocessed', () => {
    const unprocessed = [{ PutRequest: { Item: { pk: 'a' } } }];
    const err = new BatchWriteIncompleteError(3, unprocessed, 10);
    expect(err.code).toBe(ErrorCode.BATCH_WRITE_INCOMPLETE);
    expect(err.succeededCount).toBe(3);
    expect(err.unprocessed).toEqual(unprocessed);
    expect(err.message).toMatch(/3 item\(s\) persisted, 1 still un-acked/);
  });

  it('BatchWriteAllIncompleteError defaults succeededCount to 0 when the caller omits it', () => {
    const err = new BatchWriteAllIncompleteError(0, 1, [new Error('boom')]);
    expect(err.succeededCount).toBe(0);
  });
});
