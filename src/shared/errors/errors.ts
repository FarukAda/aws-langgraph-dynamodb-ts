import type { WriteRequest } from '../dynamodb/types';
import { redactedMessage } from '../logging/secret-patterns';
import { DynamoDBLangGraphError } from './base-error';
import { ErrorCode } from './error-code';
import { toError } from './to-error';

/** Input failed a validation rule before any AWS call was made; `context.field` names the input. */
export class ValidationError extends DynamoDBLangGraphError<ErrorCode.VALIDATION> {
  /**
   * Accepts: `field` — the option, argument or cap that failed, dotted for a
   * nested one (`s3.bucketName`). Omitted only where no single input is at
   * fault.
   *
   * Returns: the error, with `code: VALIDATION` and `context.field` set when a
   * field was named — which is what a caller branches on to point at the
   * offending input.
   *
   * Throws: nothing; building an error may not fail.
   */
  constructor(message: string, field?: string, cause?: Error) {
    super(message, ErrorCode.VALIDATION, field === undefined ? {} : { field }, cause);
    this.name = 'ValidationError';
  }
}

/** A conditional write failed because the precondition no longer holds. */
export class ConflictError extends DynamoDBLangGraphError<ErrorCode.CONDITION_CONFLICT> {
  /**
   * Accepts: `message` — what precondition no longer held. `cause` — the rejection
   * beneath it, when there is one.
   *
   * Returns: the error, with `code: CONDITION_CONFLICT`. A caller may retry the
   * operation from a fresh read; nothing was written.
   *
   * Throws: nothing; building an error may not fail.
   */
  constructor(message: string, cause?: Error) {
    super(message, ErrorCode.CONDITION_CONFLICT, {}, cause);
    this.name = 'ConflictError';
  }
}

/** A retried operation exhausted its attempt budget. */
export class RetryExhaustedError extends DynamoDBLangGraphError<ErrorCode.RETRY_EXHAUSTED> {
  /**
   * Accepts: `attempts` — how many were made before the budget ran out. `cause` —
   * the last failure, kept so a caller can classify what actually went wrong.
   *
   * Returns: the error, with `code: RETRY_EXHAUSTED` and `context.attempts`. It
   * says the attempts are spent, **not** that the operation did not happen: a
   * write whose response was lost is reported this way too, which is why every
   * caller that would delete something reads the row back first.
   *
   * Throws: nothing; building an error may not fail.
   */
  constructor(message: string, attempts?: number, cause?: Error) {
    super(message, ErrorCode.RETRY_EXHAUSTED, attempts === undefined ? {} : { attempts }, cause);
    this.name = 'RetryExhaustedError';
  }
}

/**
 * A paginated read hit its runaway guard (item or iteration cap) while more
 * data remained, so the result would have been silently truncated. Narrow the
 * query (filter/prefix) or raise the cap rather than trusting a partial result.
 * `context.field` names the cap that was hit.
 */
export class ResultTruncatedError extends DynamoDBLangGraphError<ErrorCode.RESULT_TRUNCATED> {
  /**
   * Accepts: `cap` — which cap was hit (`maxItems`, `maxIterations`). `limit` —
   * its value, quoted in the message so the fix is obvious.
   *
   * Returns: the error, with `code: RESULT_TRUNCATED` and `context.field` naming
   * the cap. Raised only when data actually remained, so it never turns a
   * complete result into a failure.
   *
   * Throws: nothing; building an error may not fail.
   */
  constructor(cap: string, limit: number) {
    super(
      `paginated read truncated at the ${cap} cap (${limit}) with more data remaining`,
      ErrorCode.RESULT_TRUNCATED,
      { field: cap },
    );
    this.name = 'ResultTruncatedError';
  }
}

/** An operation was cancelled via its AbortSignal. */
export class AbortError extends DynamoDBLangGraphError<ErrorCode.ABORTED> {
  /**
   * Accepts: `cause` — the `AbortSignal`'s own reason, when it carried one.
   *
   * Returns: the error, with `code: ABORTED`. Distinct from every failure code on
   * purpose: a caller who cancelled did not encounter a fault, and treating
   * the two alike reported an incomplete write for a deliberate stop.
   *
   * Throws: nothing; building an error may not fail.
   */
  constructor(message = 'Operation aborted', cause?: Error) {
    super(message, ErrorCode.ABORTED, {}, cause);
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
export class BatchWriteIncompleteError extends DynamoDBLangGraphError<ErrorCode.BATCH_WRITE_INCOMPLETE> {
  readonly succeededCount: number;
  readonly unprocessed: WriteRequest[];

  /**
   * Accepts: `succeededCount` — writes DynamoDB acked. `unprocessed` — the
   * requests it did not, verbatim, so they can be re-submitted. `retries` —
   * rounds spent. `cause` — an error that interrupted the drain, rather than a
   * clean exhaustion of the budget.
   *
   * Returns: the error, carrying both counts. Items *not* listed in `unprocessed`
   * persist: there is no rollback, so reconciliation is driven from that list.
   * That list is **copied**: it is read from a `catch` long after the throw, and
   * a caller reusing its request buffer must not be able to rewrite it.
   *
   * Throws: nothing; building an error may not fail. Anything but an array of
   * requests reads as an empty list rather than crashing the report.
   */
  constructor(succeededCount: number, unprocessed: WriteRequest[], retries: number, cause?: Error) {
    const items = Array.isArray(unprocessed) ? [...unprocessed] : [];
    super(
      `batchWrite did not drain after ${retries} UnprocessedItems retries: ` +
        `${succeededCount} item(s) persisted, ${items.length} still un-acked.`,
      ErrorCode.BATCH_WRITE_INCOMPLETE,
      {},
      cause,
      { kind: 'drain', succeededCount, unprocessed: items, retries },
    );
    this.name = 'BatchWriteIncompleteError';
    this.succeededCount = succeededCount;
    this.unprocessed = items;
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
 *
 * A partition-wide delete reports through the same error, because what it
 * answers is the same question — how much of this call got through — but it
 * sends one conditional request per row rather than a batch of twenty-five, so
 * it counts rows where this counts chunks and says so in its message.
 */
export class BatchWriteAllIncompleteError extends DynamoDBLangGraphError<ErrorCode.BATCH_WRITE_INCOMPLETE> {
  readonly succeededChunks: number;
  readonly totalChunks: number;
  readonly failedChunks: Error[];
  readonly succeededCount: number;

  /**
   * Accepts: `succeededChunks`/`totalChunks` — the chunk tally.
   * `failedChunks` — each failing chunk's own error, commonly a
   * {@link BatchWriteIncompleteError}. `succeededCount` — individual writes
   * confirmed persisted across every chunk, which is more precise than the
   * chunk tally when a chunk partially drains. `unit` — what the first two
   * counts count, so a caller that sends one conditional request per row rather
   * than a batch of twenty-five is not described as a batch that did not drain;
   * omitting it reproduces the batch wording exactly.
   *
   * Returns: the error, with the first failing chunk's error as `cause`. Every
   * chunk not represented in `failedChunks` drained successfully and its writes
   * persist — there is no rollback. The list is **copied**, for the same reason
   * {@link BatchWriteIncompleteError} copies its own.
   *
   * Throws: nothing; building an error may not fail. Anything but an array of
   * errors reads as an empty list rather than crashing the report.
   */
  constructor(
    succeededChunks: number,
    totalChunks: number,
    failedChunks: Error[],
    succeededCount = 0,
    unit: 'chunk' | 'row' = 'chunk',
  ) {
    const failed = Array.isArray(failedChunks) ? [...failedChunks] : [];
    super(
      `${unit === 'chunk' ? 'batchWriteAll' : 'the partition delete'} did not fully drain: ` +
        `${succeededChunks}/${totalChunks} ${unit}(s) succeeded, ` +
        `${failed.length} ${unit}(s) failed. ${succeededCount} write(s) persisted before the failure.`,
      ErrorCode.BATCH_WRITE_INCOMPLETE,
      {},
      failed[0],
      { kind: 'pass', unit, succeededChunks, totalChunks, failedChunks: failed, succeededCount },
    );
    this.name = 'BatchWriteAllIncompleteError';
    this.succeededChunks = succeededChunks;
    this.totalChunks = totalChunks;
    this.failedChunks = failed;
    this.succeededCount = succeededCount;
  }
}

/**
 * A compensating rollback failed after an append-saga chunk error, so the
 * trigger error could not be cleanly undone. Carries the original trigger as
 * `cause` and the rollback failure as {@link rollbackError}; the session's
 * `messageCount` may have drifted — repair it with `reconcileMessageCount`.
 */
export class CompensationFailedError extends DynamoDBLangGraphError<ErrorCode.COMPENSATION_FAILED> {
  readonly rollbackError: Error;

  /**
   * Accepts: `cause` — the failure that triggered the rollback. `rollbackError` —
   * why the rollback itself could not finish. Both are built from a `catch`, so
   * either may be whatever a `throw` produced rather than an `Error`.
   *
   * Returns: the error, carrying both, each normalised through `toError`
   * so `cause` and `rollbackError` are always error-shaped. The session's
   * `messageCount` may have drifted, which `reconcileMessageCount` repairs; the
   * quoted text of both errors is redacted before it is embedded.
   *
   * Throws: nothing; building an error may not fail. Reading `.message` off a
   * thrown non-`Error` crashed here, inside the `catch` that was reporting the
   * rollback.
   */
  constructor(cause: Error, rollbackError: Error) {
    const trigger = toError(cause);
    const rollback = toError(rollbackError);
    super(
      `compensation failed after an append error: ${redactedMessage(trigger)} ` +
        `(rollback: ${redactedMessage(rollback)})`,
      ErrorCode.COMPENSATION_FAILED,
      {},
      trigger,
      { rollbackError: rollback },
    );
    this.name = 'CompensationFailedError';
    this.rollbackError = rollback;
  }
}
