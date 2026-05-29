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
 * no rollback (drive reconciliation from `unprocessed`).
 */
export class BatchWriteIncompleteError extends DynamoDbLangGraphError {
  readonly succeededCount: number;
  readonly unprocessed: WriteRequest[];

  constructor(succeededCount: number, unprocessed: WriteRequest[], retries: number) {
    super(
      `batchWrite did not drain after ${retries} UnprocessedItems retries: ` +
        `${succeededCount} item(s) persisted, ${unprocessed.length} still un-acked.`,
      ErrorCode.BATCH_WRITE_INCOMPLETE,
    );
    this.name = 'BatchWriteIncompleteError';
    this.succeededCount = succeededCount;
    this.unprocessed = unprocessed;
  }
}
