import type { WriteRequest } from '../dynamodb/types';
import { DynamoDbLangGraphError } from './base-error';
import { ErrorCode } from './error-code';

/** Input failed a validation rule before any AWS call was made. */
export class ValidationError extends DynamoDbLangGraphError {
  constructor(message: string, field?: string) {
    super(message, ErrorCode.VALIDATION, field === undefined ? {} : { operation: field });
    this.name = 'ValidationError';
  }
}

/** A conditional write failed because the precondition no longer holds. */
export class ConflictError extends DynamoDbLangGraphError {
  constructor(message: string, cause?: Error) {
    super(message, ErrorCode.CONDITION_CONFLICT, {}, cause);
    this.name = 'ConflictError';
  }
}

/** A retried operation exhausted its attempt budget. */
export class RetryExhaustedError extends DynamoDbLangGraphError {
  constructor(message: string, attempts?: number, cause?: Error) {
    super(message, ErrorCode.RETRY_EXHAUSTED, attempts === undefined ? {} : { attempts }, cause);
    this.name = 'RetryExhaustedError';
  }
}

/**
 * A paginated read hit its runaway guard (item or iteration cap) while more
 * data remained, so the result would have been silently truncated. Narrow the
 * query (filter/prefix) or raise the cap rather than trusting a partial result.
 */
export class ResultTruncatedError extends DynamoDbLangGraphError {
  constructor(cap: string, limit: number) {
    super(
      `paginated read truncated at the ${cap} cap (${limit}) with more data remaining`,
      ErrorCode.RESULT_TRUNCATED,
      { operation: cap },
    );
    this.name = 'ResultTruncatedError';
  }
}

/** An operation was cancelled via its AbortSignal. */
export class AbortError extends DynamoDbLangGraphError {
  constructor(message = 'Operation aborted') {
    super(message, ErrorCode.ABORTED);
    this.name = 'AbortError';
  }
}

/**
 * A BatchWriteItem sequence could not drain its UnprocessedItems. Items NOT
 * listed in {@link unprocessed} were acked by DynamoDB and persist — there is
 * no rollback (drive reconciliation from `unprocessed`). `cause`, when given,
 * is the underlying failure that interrupted the drain (e.g. a thrown,
 * non-UnprocessedItems error from a retry round) rather than a clean exhaustion
 * of the UnprocessedItems retry budget.
 */
export class BatchWriteIncompleteError extends DynamoDbLangGraphError {
  readonly succeededCount: number;
  readonly unprocessed: WriteRequest[];

  constructor(succeededCount: number, unprocessed: WriteRequest[], retries: number, cause?: Error) {
    super(
      `batchWrite did not drain after ${retries} UnprocessedItems retries: ` +
        `${succeededCount} item(s) persisted, ${unprocessed.length} still un-acked.`,
      ErrorCode.BATCH_WRITE_INCOMPLETE,
      {},
      cause,
    );
    this.name = 'BatchWriteIncompleteError';
    this.succeededCount = succeededCount;
    this.unprocessed = unprocessed;
  }
}

/**
 * batchWriteAll attempts every chunk rather than stopping at the first
 * failure — a mid-sequence chunk failing does not abandon the chunks after
 * it. `failedChunks` holds each failing chunk's own error (commonly a
 * {@link BatchWriteIncompleteError}); every chunk not represented there
 * drained successfully and its writes persist — there is no rollback.
 * `succeededCount` is the exact number of individual write requests
 * confirmed persisted across every chunk (full chunks plus any failed
 * chunk's own partial drain), more precise than `succeededChunks` alone
 * when a chunk partially drains before exhausting its retries.
 */
export class BatchWriteAllIncompleteError extends DynamoDbLangGraphError {
  readonly succeededChunks: number;
  readonly totalChunks: number;
  readonly failedChunks: Error[];
  readonly succeededCount: number;

  constructor(
    succeededChunks: number,
    totalChunks: number,
    failedChunks: Error[],
    succeededCount = 0,
  ) {
    super(
      `batchWriteAll did not fully drain: ${succeededChunks}/${totalChunks} chunk(s) succeeded, ` +
        `${failedChunks.length} chunk(s) failed. ${succeededCount} write(s) persisted before the failure.`,
      ErrorCode.BATCH_WRITE_INCOMPLETE,
      {},
      failedChunks[0],
    );
    this.name = 'BatchWriteAllIncompleteError';
    this.succeededChunks = succeededChunks;
    this.totalChunks = totalChunks;
    this.failedChunks = failedChunks;
    this.succeededCount = succeededCount;
  }
}

/**
 * A compensating rollback failed after an append-saga chunk error, so the
 * trigger error could not be cleanly undone. Carries the original trigger as
 * `cause` and the rollback failure as {@link rollbackError}; the session's
 * `messageCount` may have drifted — repair it with `reconcileMessageCount`.
 */
export class CompensationFailedError extends DynamoDbLangGraphError {
  readonly rollbackError: Error;

  constructor(cause: Error, rollbackError: Error) {
    super(
      `compensation failed after an append error: ${cause.message} (rollback: ${rollbackError.message})`,
      ErrorCode.COMPENSATION_FAILED,
      {},
      cause,
    );
    this.name = 'CompensationFailedError';
    this.rollbackError = rollbackError;
  }
}
