import { isDynamoDBLangGraphError } from '../../../../src/shared/errors/base-error';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import {
  abortError,
  batchWriteAllIncompleteError,
  batchWriteIncompleteError,
  compensationFailedError,
  conflictError,
  resultTruncatedError,
  retryBudgetMayStillLand,
  retryExhaustedError,
  unsettledAppendError,
  validationError,
} from '../../../../src/shared/errors/errors';

/** Every factory, called with the least it accepts. */
const EVERY_FACTORY = [
  ['validationError', () => validationError('v')],
  ['conflictError', () => conflictError('c')],
  ['retryExhaustedError', () => retryExhaustedError('r')],
  ['resultTruncatedError', () => resultTruncatedError('maxItems', 1)],
  ['abortError', () => abortError()],
  ['batchWriteIncompleteError', () => batchWriteIncompleteError(0, [], 1)],
  [
    'batchWriteAllIncompleteError',
    () => batchWriteAllIncompleteError({ succeeded: 0, total: 1, failures: [] }),
  ],
  ['compensationFailedError', () => compensationFailedError(new Error('t'), new Error('r'))],
  ['unsettledAppendError', () => unsettledAppendError(new Error('t'), new Error('u'))],
] as const;

describe('every factory', () => {
  /** One class: a caller tells errors apart by `code`, never by `name` or prototype. */
  it.each(EVERY_FACTORY)('%s builds the one branded class', (_name, build) => {
    const error = build();
    expect(error.name).toBe('DynamoDBLangGraphError');
    expect(isDynamoDBLangGraphError(error)).toBe(true);
  });

  /**
   * The top frame is the one a reader follows. Built inside a helper, every
   * stack would open on that helper and hide the line that raised the error.
   */
  it.each(EVERY_FACTORY)('%s starts the stack at its caller', (_name, build) => {
    const [, top] = (build().stack ?? '').split('\n');
    expect(top).toBeDefined();
    expect(top).not.toContain('errors.ts');
    expect(top).toContain('errors.test.ts');
  });

  it('fixes each code', () => {
    expect(validationError('v').code).toBe(ErrorCode.VALIDATION);
    expect(conflictError('c').code).toBe(ErrorCode.CONDITION_CONFLICT);
    expect(retryExhaustedError('r').code).toBe(ErrorCode.RETRY_EXHAUSTED);
    expect(abortError().code).toBe(ErrorCode.ABORTED);
    expect(resultTruncatedError('maxItems', 10000).code).toBe(ErrorCode.RESULT_TRUNCATED);
  });
});

describe('validationError', () => {
  it('names the field and keeps the cause', () => {
    const cause = new Error('under');
    expect(validationError('bad', 'tableName', cause)).toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'tableName' },
      message: 'bad',
      cause,
    });
  });

  it('reports the offending field in context.field, not as an operation', () => {
    expect(validationError('bad', 'tableName').context).toEqual({ field: 'tableName' });
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

  it('defaults the mayStillLand record to false', () => {
    expect(retryBudgetMayStillLand(retryExhaustedError('exhausted'))).toBe(false);
  });

  it('carries the AWS diagnostics of the last failure', () => {
    const last = Object.assign(new Error('throttled'), {
      name: 'ThrottlingException',
      $metadata: { httpStatusCode: 400, requestId: 'r9' },
    });
    expect(retryExhaustedError('spent', 5, last).context).toEqual({
      attempts: 5,
      awsErrorName: 'ThrottlingException',
      httpStatusCode: 400,
      requestId: 'r9',
    });
  });

  it('carries only the attempts when the last failure was not AWS-shaped', () => {
    expect(retryExhaustedError('spent', 5, new Error('x')).context).toEqual({ attempts: 5 });
  });
});

describe('retryBudgetMayStillLand', () => {
  it('reads back what retryExhaustedError recorded', () => {
    expect(retryBudgetMayStillLand(retryExhaustedError('exhausted', 3, undefined, true))).toBe(
      true,
    );
    expect(retryBudgetMayStillLand(retryExhaustedError('exhausted', 3, undefined, false))).toBe(
      false,
    );
  });

  it('is false for any error that is not one this factory built', () => {
    expect(retryBudgetMayStillLand(new Error('plain'))).toBe(false);
    expect(retryBudgetMayStillLand(validationError('bad'))).toBe(false);
  });

  it('is false for a value that cannot carry a property', () => {
    expect(retryBudgetMayStillLand(null as never)).toBe(false);
    expect(retryBudgetMayStillLand('not an error' as never)).toBe(false);
  });
});

describe('resultTruncatedError', () => {
  it('names the cap as the field and quotes the limit in the message', () => {
    const error = resultTruncatedError('maxIterations', 1000);
    expect(error.code).toBe(ErrorCode.RESULT_TRUNCATED);
    expect(error.message).toMatch(/maxIterations cap \(1000\)/);
    /** The cap is the offending field, not the operation that was running. */
    expect(error.context).toEqual({ field: 'maxIterations' });
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
  it('carries a drain record with both counts', () => {
    const unprocessed = [{ PutRequest: { Item: { pk: 'a' } } }];
    const error = batchWriteIncompleteError(3, unprocessed, 10);
    expect(error.code).toBe(ErrorCode.BATCH_WRITE_INCOMPLETE);
    expect(error.details).toEqual({ kind: 'drain', succeededCount: 3, unprocessed, retries: 10 });
    expect(error.message).toMatch(/3 item\(s\) persisted, 1 still un-acked/);
  });

  /**
   * The list is read long after the throw — from a `catch`, to drive
   * reconciliation. Holding the caller's array by reference let a caller that
   * reuses its buffer rewrite the contents of an error already in flight.
   */
  it('copies the unprocessed list it is handed', () => {
    const unprocessed = [{ PutRequest: { Item: { pk: 'a' } } }];
    const error = batchWriteIncompleteError(1, unprocessed, 2);
    unprocessed.push({ PutRequest: { Item: { pk: 'b' } } });
    expect(error.details).toMatchObject({
      kind: 'drain',
      unprocessed: [{ PutRequest: { Item: { pk: 'a' } } }],
    });
  });

  /**
   * "Throws: nothing; building an error may not fail", and it is reached from
   * a `catch`: crashing on an argument it did not expect would replace the
   * failure being reported with a bare `TypeError` that names none of it.
   */
  it('reads a missing or non-array unprocessed list as empty rather than crashing', () => {
    const missing = batchWriteIncompleteError(0, undefined as never, 1);
    expect(missing.details).toMatchObject({ unprocessed: [] });
    expect(missing.message).toContain('0 still un-acked');
    expect(batchWriteIncompleteError(0, 'x' as never, 1).details).toMatchObject({
      unprocessed: [],
    });
  });
});

describe('batchWriteAllIncompleteError', () => {
  it('carries a pass record, in rows when asked, with the first failure as cause', () => {
    const first = new Error('first');
    const error = batchWriteAllIncompleteError({
      succeeded: 1,
      total: 2,
      failures: [first],
      succeededCount: 5,
      unit: 'row',
    });
    expect(error.cause).toBe(first);
    expect(error.details).toEqual({
      kind: 'pass',
      unit: 'row',
      succeededChunks: 1,
      totalChunks: 2,
      failedChunks: [first],
      succeededCount: 5,
    });
  });

  it('defaults succeededCount to 0 when the caller omits it', () => {
    expect(
      batchWriteAllIncompleteError({ succeeded: 0, total: 1, failures: [new Error('boom')] })
        .details,
    ).toMatchObject({
      succeededCount: 0,
    });
  });

  /** The chunk wording is the default, so the batch path's message is untouched. */
  it('counts rows when a caller deletes one row per request', () => {
    const batched = batchWriteAllIncompleteError({
      succeeded: 1,
      total: 2,
      failures: [new Error('boom')],
      succeededCount: 25,
    });
    expect(batched.message).toContain('batchWriteAll did not fully drain: 1/2 chunk(s) succeeded');
    const perRow = batchWriteAllIncompleteError({
      succeeded: 1,
      total: 2,
      failures: [new Error('boom')],
      succeededCount: 1,
      unit: 'row',
    });
    expect(perRow.message).toContain('the partition delete did not fully drain');
    expect(perRow.message).toContain('1/2 row(s) succeeded, 1 row(s) failed');
    expect(perRow.message).not.toContain('batchWriteAll');
  });

  it('keeps the chunks that had failed at the throw', () => {
    const failed = [new Error('boom')];
    const error = batchWriteAllIncompleteError({ succeeded: 0, total: 2, failures: failed });
    failed.push(new Error('later'));
    expect(error.details).toMatchObject({ failedChunks: [expect.any(Error)] });
  });

  it('reads a missing or non-array failure list as empty rather than crashing', () => {
    const missing = batchWriteAllIncompleteError({
      succeeded: 0,
      total: 1,
      failures: undefined as never,
    });
    expect(missing.code).toBe(ErrorCode.BATCH_WRITE_INCOMPLETE);
    expect(missing.details).toMatchObject({ failedChunks: [] });
    expect(missing.cause).toBeUndefined();
    expect(missing.message).toContain('0 chunk(s) failed');
    expect(
      batchWriteAllIncompleteError({ succeeded: 0, total: 1, failures: 'x' as never }).details,
    ).toMatchObject({
      failedChunks: [],
    });
  });
});

describe('compensationFailedError', () => {
  it('carries the trigger as cause and the rollback failure in details', () => {
    const trigger = new Error('append failed');
    const rollback = new Error('delete failed');
    const error = compensationFailedError(trigger, rollback);
    expect(error.code).toBe(ErrorCode.COMPENSATION_FAILED);
    expect(error.cause).toBe(trigger);
    expect(error.details).toEqual({ rollbackError: rollback });
    expect(error.message).toMatch(/append failed/);
    expect(error.message).toMatch(/delete failed/);
  });

  it('normalises a trigger and a rollback that are not errors through toError', () => {
    const error = compensationFailedError('trigger blew up' as never, null as never);
    expect(error.code).toBe(ErrorCode.COMPENSATION_FAILED);
    expect(error.message).toContain('trigger blew up');
    expect((error.cause as Error).message).toBe('trigger blew up');
    expect(error.details.rollbackError.message).toBe('null was thrown');
  });
});

describe('unsettledAppendError', () => {
  it('carries the trigger as cause and why the chunk is unsettled in details', () => {
    const trigger = new Error('append failed');
    const unsettledBecause = new Error('read-back timed out');
    const error = unsettledAppendError(trigger, unsettledBecause);
    expect(error.code).toBe(ErrorCode.COMPENSATION_FAILED);
    expect(error.cause).toBe(trigger);
    expect(error.details).toEqual({ rollbackError: unsettledBecause });
    expect(error.message).toMatch(/append failed/);
    expect(error.message).toMatch(/read-back timed out/);
  });

  /**
   * The rollback that undid every other chunk did not fail here — it is
   * this one chunk's own fate that could not be established. A message that
   * says "rollback" would tell an operator the wrong thing happened.
   */
  it('never claims a failed rollback, unlike compensationFailedError', () => {
    const error = unsettledAppendError(new Error('append failed'), new Error('unsettled'));
    expect(error.message).not.toContain('rollback');
  });

  it('normalises a trigger and an unsettled reason that are not errors through toError', () => {
    const error = unsettledAppendError('trigger blew up' as never, null as never);
    expect(error.code).toBe(ErrorCode.COMPENSATION_FAILED);
    expect(error.message).toContain('trigger blew up');
    expect((error.cause as Error).message).toBe('trigger blew up');
    expect(error.details.rollbackError.message).toBe('null was thrown');
  });
});
