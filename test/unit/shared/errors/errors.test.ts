import { ErrorCode } from '../../../../src/shared/errors/error-code';
import {
  AbortError,
  abortError,
  BatchWriteAllIncompleteError,
  batchWriteAllIncompleteError,
  BatchWriteIncompleteError,
  batchWriteIncompleteError,
  CompensationFailedError,
  compensationFailedError,
  ConflictError,
  conflictError,
  ResultTruncatedError,
  resultTruncatedError,
  RetryExhaustedError,
  retryExhaustedError,
  ValidationError,
  validationError,
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
    // The cap is the offending *field*, not the operation that was running (CORE-06).
    expect(err.context).toEqual({ field: 'maxIterations' });
  });

  it('ValidationError reports the offending field in context.field, not as an operation', () => {
    expect(new ValidationError('bad', 'tableName').context).toEqual({ field: 'tableName' });
    expect(new ValidationError('bad').context).toEqual({});
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

  /** The chunk wording is the default, so the batch path's message is untouched. */
  it('BatchWriteAllIncompleteError counts rows when a caller deletes one row per request', () => {
    const batched = new BatchWriteAllIncompleteError(1, 2, [new Error('boom')], 25);
    expect(batched.message).toContain('batchWriteAll did not fully drain: 1/2 chunk(s) succeeded');
    const perRow = new BatchWriteAllIncompleteError(1, 2, [new Error('boom')], 1, 'row');
    expect(perRow.message).toContain('1/2 row(s) succeeded, 1 row(s) failed');
    expect(perRow.message).not.toContain('batchWriteAll');
  });
});

/**
 * Every constructor here documents "Throws: nothing; building an error may not
 * fail", and each is reached from a `catch` on the failure path. A constructor
 * that crashes on an argument it did not expect replaces the failure being
 * reported with a bare `TypeError` that names none of it.
 */
describe('error constructors survive the arguments a JavaScript caller can reach', () => {
  it('BatchWriteAllIncompleteError reports the failure when no failing chunk is passed', () => {
    const error = new BatchWriteAllIncompleteError(0, 1, undefined as never);
    expect(error.code).toBe(ErrorCode.BATCH_WRITE_INCOMPLETE);
    expect(error.failedChunks).toEqual([]);
    expect(error.cause).toBeUndefined();
    expect(error.message).toContain('0 chunk(s) failed');
  });

  it('BatchWriteIncompleteError reports the failure when no unprocessed list is passed', () => {
    const error = new BatchWriteIncompleteError(0, undefined as never, 1);
    expect(error.code).toBe(ErrorCode.BATCH_WRITE_INCOMPLETE);
    expect(error.unprocessed).toEqual([]);
    expect(error.message).toContain('0 still un-acked');
  });

  it('CompensationFailedError describes a trigger and a rollback that are not errors', () => {
    const error = new CompensationFailedError('append blew up' as never, null as never);
    expect(error.code).toBe(ErrorCode.COMPENSATION_FAILED);
    expect(error.message).toContain('append blew up');
    expect(error.rollbackError.message).toBe('null was thrown');
    expect((error.cause as Error).message).toBe('append blew up');
  });
});

/**
 * Both lists are read long after the throw — from a `catch`, to drive
 * reconciliation. Holding the caller's array by reference let a caller that
 * reuses its buffer rewrite the contents of an error already in flight.
 */
describe('error constructors copy the lists they are handed', () => {
  it('BatchWriteIncompleteError keeps the items that were un-acked at the throw', () => {
    const unprocessed = [{ PutRequest: { Item: { pk: 'a' } } }];
    const error = new BatchWriteIncompleteError(1, unprocessed, 1);
    unprocessed.push({ PutRequest: { Item: { pk: 'b' } } });
    expect(error.unprocessed).toHaveLength(1);
  });

  it('BatchWriteAllIncompleteError keeps the chunks that had failed at the throw', () => {
    const failed = [new Error('boom')];
    const error = new BatchWriteAllIncompleteError(0, 2, failed);
    failed.push(new Error('later'));
    expect(error.failedChunks).toHaveLength(1);
  });
});

describe('the subclasses fill details', () => {
  it('BatchWriteIncompleteError carries a drain record', () => {
    const error = new BatchWriteIncompleteError(2, [], 3);
    expect(error.details).toEqual({
      kind: 'drain',
      succeededCount: 2,
      unprocessed: [],
      retries: 3,
    });
  });

  it('BatchWriteAllIncompleteError carries a pass record, in rows when asked', () => {
    const failure = new Error('x');
    const error = new BatchWriteAllIncompleteError(1, 2, [failure], 5, 'row');
    expect(error.details).toEqual({
      kind: 'pass',
      unit: 'row',
      succeededChunks: 1,
      totalChunks: 2,
      failedChunks: [failure],
      succeededCount: 5,
    });
  });

  it('CompensationFailedError carries the rollback failure', () => {
    const rollback = new Error('rollback');
    expect(new CompensationFailedError(new Error('t'), rollback).details).toEqual({
      rollbackError: rollback,
    });
  });
});

/**
 * Each factory returns the same subclass instance the class constructor
 * would; the factories exist so an internal caller never names a subclass,
 * which is what lets a later change collapse the subclasses by editing only
 * these eight bodies.
 */
describe('validationError', () => {
  it('names the field and keeps the cause', () => {
    const cause = new Error('under');
    expect(validationError('bad', 'tableName', cause)).toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'tableName' },
      message: 'bad',
      cause,
    });
    expect(validationError('bad').context).toEqual({});
  });
});

describe('conflictError', () => {
  it('keeps the message and the cause', () => {
    const cause = new Error('stale');
    expect(conflictError('precondition failed', cause)).toMatchObject({
      code: ErrorCode.CONDITION_CONFLICT,
      context: {},
      message: 'precondition failed',
      cause,
    });
  });
});

describe('retryExhaustedError', () => {
  it('names the attempts spent and keeps the cause', () => {
    const cause = new Error('last failure');
    expect(retryExhaustedError('exhausted', 3, cause)).toMatchObject({
      code: ErrorCode.RETRY_EXHAUSTED,
      context: { attempts: 3 },
      message: 'exhausted',
      cause,
    });
  });

  it('omits attempts from context when none is given', () => {
    expect(retryExhaustedError('exhausted').context).toEqual({});
  });
});

describe('resultTruncatedError', () => {
  it('names the cap as the field and quotes the limit in the message', () => {
    const error = resultTruncatedError('maxItems', 10000);
    expect(error.code).toBe(ErrorCode.RESULT_TRUNCATED);
    expect(error.context).toEqual({ field: 'maxItems' });
    expect(error.message).toContain('maxItems cap (10000)');
  });
});

describe('abortError', () => {
  it('defaults the message to Operation aborted and keeps the cause', () => {
    const cause = new Error('signal reason');
    const error = abortError(undefined, cause);
    expect(error.code).toBe(ErrorCode.ABORTED);
    expect(error.message).toBe('Operation aborted');
    expect(error.cause).toBe(cause);
  });

  it('uses the given message', () => {
    expect(abortError('stopped').message).toBe('stopped');
  });
});

describe('batchWriteIncompleteError', () => {
  it('copies the unprocessed list it is handed', () => {
    const unprocessed = [{ PutRequest: { Item: { pk: 'a' } } }];
    const error = batchWriteIncompleteError(1, unprocessed, 2);
    unprocessed.push({ PutRequest: { Item: { pk: 'b' } } });
    expect(error.code).toBe(ErrorCode.BATCH_WRITE_INCOMPLETE);
    expect(error.details).toMatchObject({
      kind: 'drain',
      unprocessed: [{ PutRequest: { Item: { pk: 'a' } } }],
    });
  });

  it('reads a non-array unprocessed list as empty rather than crashing the report', () => {
    expect(batchWriteIncompleteError(0, 'x' as never, 1).details).toMatchObject({
      unprocessed: [],
    });
  });
});

describe('batchWriteAllIncompleteError', () => {
  it('counts rows when asked, and uses the first failure as cause', () => {
    const first = new Error('first');
    const error = batchWriteAllIncompleteError(1, 3, [first, new Error('second')], 1, 'row');
    expect(error.message).toContain('the partition delete did not fully drain');
    expect(error.cause).toBe(first);
    expect(error.details).toMatchObject({ kind: 'pass', unit: 'row', totalChunks: 3 });
  });

  it('reads a non-array failure list as empty rather than crashing the report', () => {
    expect(batchWriteAllIncompleteError(0, 1, 'x' as never).details).toMatchObject({
      failedChunks: [],
    });
  });
});

describe('compensationFailedError', () => {
  it('normalises both the trigger and the rollback failure through toError, redacted in the message', () => {
    const error = compensationFailedError('trigger blew up' as never, null as never);
    expect(error.code).toBe(ErrorCode.COMPENSATION_FAILED);
    expect(error.message).toContain('trigger blew up');
    expect((error.cause as Error).message).toBe('trigger blew up');
    expect(error.details).toMatchObject({ rollbackError: { message: 'null was thrown' } });
  });
});
