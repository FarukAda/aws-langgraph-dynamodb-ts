import { ErrorCode } from '../../../../src/shared/errors/error-code';
import {
  AbortError,
  BatchWriteIncompleteError,
  ConflictError,
  RetryExhaustedError,
  ValidationError,
} from '../../../../src/shared/errors/errors';

describe('error subclasses', () => {
  it('each fixes its ErrorCode', () => {
    expect(new ValidationError('v').code).toBe(ErrorCode.VALIDATION);
    expect(new ConflictError('c').code).toBe(ErrorCode.CONDITION_CONFLICT);
    expect(new RetryExhaustedError('r').code).toBe(ErrorCode.RETRY_EXHAUSTED);
    expect(new AbortError().code).toBe(ErrorCode.ABORTED);
  });

  it('BatchWriteIncompleteError keeps succeededCount and unprocessed', () => {
    const unprocessed = [{ PutRequest: { Item: { pk: 'a' } } }];
    const err = new BatchWriteIncompleteError(3, unprocessed, 10);
    expect(err.code).toBe(ErrorCode.BATCH_WRITE_INCOMPLETE);
    expect(err.succeededCount).toBe(3);
    expect(err.unprocessed).toEqual(unprocessed);
    expect(err.message).toMatch(/3 item\(s\) persisted, 1 still un-acked/);
  });
});
