/**
 * Hides what each of this library's errors carries, for the codes that have
 * a factory here.
 *
 * A failure site with a factory below names it for its code and the facts it
 * has. The message wording, which facts go into `context` or `details`,
 * copying a list a caller reads from a `catch` long after the throw,
 * redacting quoted cause text, and a stack that starts at the caller rather
 * than inside the factory are decided here once per code, on the one error
 * class (record 19). `FORMAT_UNSUPPORTED`, `PAYLOAD_CORRUPT`,
 * `COMPRESSION_LIMIT`, `S3_OFFLOAD_FAILED` and `ANCESTOR_EXPIRED` are raised
 * with `new DynamoDBLangGraphError` at their own call sites instead, and
 * every AWS-classified code is wrapped once, by `wrapForeignError` in the
 * error boundary, not per code here.
 */

import type { WriteRequest } from '../dynamodb/client';
import { redactedMessage } from '../logging/secret-patterns';
import {
  DynamoDBLangGraphError,
  toError,
  type ErrorContext,
  type ErrorDetailsFor,
} from './base-error';
import { ErrorCode } from './error-code';

/**
 * Build one error, with the stack starting at the code that called `factory`
 * rather than inside it: the top frame is the one a reader follows.
 */
function build<C extends ErrorCode>(
  factory: (...args: never[]) => DynamoDBLangGraphError,
  spec: {
    message: string;
    code: C;
    context: ErrorContext;
    cause?: Error;
    details?: ErrorDetailsFor<C>;
  },
): DynamoDBLangGraphError<C> {
  const error = new DynamoDBLangGraphError(
    spec.message,
    spec.code,
    spec.context,
    spec.cause,
    spec.details,
  );
  Error.captureStackTrace(error, factory);
  return error;
}

/**
 * The error for input that failed a check before any AWS call was made.
 *
 * Accepts: `message` — already redacted by whoever composed it. `field` — the
 * option, argument or cap that failed, dotted for a nested one
 * (`s3.bucketName`); omitted only where no single input is at fault. `cause` —
 * the refusal beneath it.
 *
 * Returns: a `VALIDATION` error, with `context.field` set when a field was
 * named — which is what a caller branches on to point at the offending input.
 *
 * Throws: nothing; building an error may not fail.
 */
export function validationError(
  message: string,
  field?: string,
  cause?: Error,
): DynamoDBLangGraphError<ErrorCode.VALIDATION> {
  return build(validationError, {
    message,
    code: ErrorCode.VALIDATION,
    context: field === undefined ? {} : { field },
    cause,
  });
}

/**
 * The error for a conditional write whose precondition no longer holds.
 *
 * Accepts: `message` — what precondition no longer held. `cause` — the
 * rejection beneath it, when there is one.
 *
 * Returns: a `CONDITION_CONFLICT` error. A caller may retry the operation
 * from a fresh read; nothing was written.
 *
 * Throws: nothing; building an error may not fail.
 */
export function conflictError(
  message: string,
  cause?: Error,
): DynamoDBLangGraphError<ErrorCode.CONDITION_CONFLICT> {
  return build(conflictError, { message, code: ErrorCode.CONDITION_CONFLICT, context: {}, cause });
}

/**
 * Non-enumerable carrier, on a `RETRY_EXHAUSTED` error, of whether *some*
 * attempt of the spent budget — not only the last, which `cause` alone
 * reports — left DynamoDB free to apply it later. Read only by
 * {@link retryBudgetMayStillLand}; never enumerable, so it never reaches a log
 * or a JSON serialization the way `context` and `details` are meant to.
 */
const MAY_STILL_LAND = Symbol('retryExhaustedError.mayStillLand');

/**
 * The error for a retried operation that exhausted its attempt budget.
 *
 * Accepts: `attempts` — how many were made before the budget ran out.
 * `cause` — the last failure, kept so a caller can classify what actually
 * went wrong. `mayStillLand` — whether any attempt of the budget, not only the
 * last, left DynamoDB free to apply it later; read back by
 * {@link retryBudgetMayStillLand}. Defaults to false, which is what a caller
 * outside `withRetry` — one built by an older release, or a test double — gets
 * for not recording one.
 *
 * Returns: a `RETRY_EXHAUSTED` error, with `context.attempts` when `attempts`
 * was given. It says the attempts are spent, **not** that the operation did
 * not happen: a write whose response was lost is reported this way too, which
 * is why every caller that would delete something reads the row back first.
 *
 * Throws: nothing; building an error may not fail.
 */
export function retryExhaustedError(
  message: string,
  attempts?: number,
  cause?: Error,
  mayStillLand = false,
): DynamoDBLangGraphError<ErrorCode.RETRY_EXHAUSTED> {
  const error = build(retryExhaustedError, {
    message,
    code: ErrorCode.RETRY_EXHAUSTED,
    context: attempts === undefined ? {} : { attempts },
    cause,
  });
  Object.defineProperty(error, MAY_STILL_LAND, { value: mayStillLand, enumerable: false });
  return error;
}

/**
 * Whether some attempt of a spent retry budget — recorded by
 * {@link retryExhaustedError} across every attempt `withRetry` made, not
 * re-derived from `cause`, which is only the last one — left DynamoDB free to
 * apply it later.
 *
 * Accepts: `error` — any error; only one `retryExhaustedError` built carries
 * the record.
 *
 * Returns: the flag recorded when the error was built; false for any other
 * error, including a `RETRY_EXHAUSTED` error built without passing one.
 *
 * Throws: nothing, for any value.
 */
export function retryBudgetMayStillLand(error: Error): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as object as Record<symbol, boolean>)[MAY_STILL_LAND] === true;
}

/**
 * The error for a paginated read that hit its runaway guard (item or
 * iteration cap) while more data remained, so the result would have been
 * silently truncated. Narrow the query (filter/prefix) or raise the cap rather
 * than trusting a partial result.
 *
 * Accepts: `cap` — which cap was hit (`maxItems`, `maxIterations`). `limit` —
 * its value, quoted in the message so the fix is obvious.
 *
 * Returns: a `RESULT_TRUNCATED` error, with `context.field` naming the cap.
 * Raised only when data actually remained, so it never turns a complete
 * result into a failure.
 *
 * Throws: nothing; building an error may not fail.
 */
export function resultTruncatedError(
  cap: string,
  limit: number,
): DynamoDBLangGraphError<ErrorCode.RESULT_TRUNCATED> {
  return build(resultTruncatedError, {
    message: `paginated read truncated at the ${cap} cap (${limit}) with more data remaining`,
    code: ErrorCode.RESULT_TRUNCATED,
    context: { field: cap },
  });
}

/**
 * The error for an operation cancelled via its `AbortSignal`.
 *
 * Accepts: `message` — defaults to `Operation aborted`. `cause` — the
 * `AbortSignal`'s own reason, when it carried one.
 *
 * Returns: an `ABORTED` error. Distinct from every failure code on purpose: a
 * caller who cancelled did not encounter a fault, and treating the two alike
 * reported an incomplete write for a deliberate stop.
 *
 * Throws: nothing; building an error may not fail.
 */
export function abortError(
  message = 'Operation aborted',
  cause?: Error,
): DynamoDBLangGraphError<ErrorCode.ABORTED> {
  return build(abortError, { message, code: ErrorCode.ABORTED, context: {}, cause });
}

/**
 * The error for a `BatchWriteItem` sequence that could not drain its
 * `UnprocessedItems`.
 *
 * Accepts: `succeededCount` — writes DynamoDB acked. `unprocessed` — the
 * requests it did not, verbatim, so they can be re-submitted. `retries` —
 * rounds spent. `cause` — an error that interrupted the drain (a thrown,
 * non-`UnprocessedItems` error from a retry round), rather than a clean
 * exhaustion of the `UnprocessedItems` retry budget.
 *
 * Returns: a `BATCH_WRITE_INCOMPLETE` error whose `details` (`kind: 'drain'`)
 * carry both counts and the list. Items *not* listed in `details.unprocessed`
 * persist: there is no rollback, so reconciliation is driven from that list.
 * That list is **copied**: it is read from a `catch` long after the throw, and
 * a caller reusing its request buffer must not be able to rewrite it.
 *
 * Throws: nothing; building an error may not fail. Anything but an array of
 * requests reads as an empty list rather than crashing the report.
 */
export function batchWriteIncompleteError(
  succeededCount: number,
  unprocessed: WriteRequest[],
  retries: number,
  cause?: Error,
): DynamoDBLangGraphError<ErrorCode.BATCH_WRITE_INCOMPLETE> {
  const items = Array.isArray(unprocessed) ? [...unprocessed] : [];
  return build(batchWriteIncompleteError, {
    message:
      `batchWrite did not drain after ${retries} UnprocessedItems retries: ` +
      `${succeededCount} item(s) persisted, ${items.length} still un-acked.`,
    code: ErrorCode.BATCH_WRITE_INCOMPLETE,
    context: {},
    cause,
    details: { kind: 'drain', succeededCount, unprocessed: items, retries },
  });
}

/** What a batch that could not finish reports. */
export interface IncompleteBatch {
  /** Chunks (or rows) that committed. */
  readonly succeeded: number;
  /** Chunks (or rows) the batch had. */
  readonly total: number;
  readonly failures: Error[];
  /** Requests that committed, when a chunk is more than one request. */
  readonly succeededCount?: number;
  readonly unit?: 'row';
}

/**
 * The error for a `batchWriteAll` pass — or a partition-wide delete — that did
 * not fully drain. `batchWriteAll` attempts every chunk rather than stopping
 * at the first failure, so a mid-sequence chunk failing does not abandon the
 * chunks after it. A partition-wide delete reports through the same shape,
 * because what it answers is the same question — how much of this call got
 * through — but it sends one conditional request per row rather than a batch
 * of twenty-five, so it counts rows where a batch counts chunks and says so in
 * its message.
 *
 * Accepts: `batch.succeeded`/`batch.total` — the chunk tally. `batch.failures`
 * — each failing chunk's own error, commonly a `BATCH_WRITE_INCOMPLETE` drain
 * error. `batch.succeededCount` — individual writes confirmed persisted across
 * every chunk (full chunks plus any failed chunk's own partial drain), which
 * is more precise than the chunk tally when a chunk partially drains.
 * `batch.unit` — what the first two counts count; omitting it reproduces the
 * batch wording exactly.
 *
 * Returns: a `BATCH_WRITE_INCOMPLETE` error whose `details` (`kind: 'pass'`)
 * carry the tally, with the first failing chunk's error as `cause`. Every
 * chunk not represented in `details.failedChunks` drained successfully and its
 * writes persist — there is no rollback. The list is **copied**, for the same
 * reason a drain error copies its own.
 *
 * Throws: nothing; building an error may not fail. Anything but an array of
 * errors reads as an empty list rather than crashing the report.
 */
export function batchWriteAllIncompleteError(
  batch: IncompleteBatch,
): DynamoDBLangGraphError<ErrorCode.BATCH_WRITE_INCOMPLETE> {
  const { succeeded, total, succeededCount = 0, unit = 'chunk' } = batch;
  const failed = Array.isArray(batch.failures) ? [...batch.failures] : [];
  return build(batchWriteAllIncompleteError, {
    message:
      `${unit === 'chunk' ? 'batchWriteAll' : 'the partition delete'} did not fully drain: ` +
      `${succeeded}/${total} ${unit}(s) succeeded, ` +
      `${failed.length} ${unit}(s) failed. ${succeededCount} write(s) persisted before the failure.`,
    code: ErrorCode.BATCH_WRITE_INCOMPLETE,
    context: {},
    cause: failed[0],
    details: {
      kind: 'pass',
      unit,
      succeededChunks: succeeded,
      totalChunks: total,
      failedChunks: failed,
      succeededCount,
    },
  });
}

/**
 * The error for a compensating rollback that failed after an append-saga
 * chunk error, so the trigger could not be cleanly undone.
 *
 * Accepts: `cause` — the failure that triggered the rollback. `rollbackError`
 * — why the rollback itself could not finish. Both are built from a `catch`,
 * so either may be whatever a `throw` produced rather than an `Error`.
 *
 * Returns: a `COMPENSATION_FAILED` error carrying the trigger as `cause` and
 * the rollback failure as `details.rollbackError`, each normalised through
 * `toError` so both are always error-shaped. The session's `messageCount` may
 * have drifted, which `reconcileMessageCount` repairs; the quoted text of both
 * errors is redacted before it is embedded.
 *
 * Throws: nothing; building an error may not fail. Reading `.message` off a
 * thrown `null` or `undefined` would throw here, inside the `catch` reporting
 * the rollback — which is why `toError` normalises both `cause` and
 * `rollbackError` before anything reads off them.
 */
export function compensationFailedError(
  cause: Error,
  rollbackError: Error,
): DynamoDBLangGraphError<ErrorCode.COMPENSATION_FAILED> {
  const trigger = toError(cause);
  const rollback = toError(rollbackError);
  return build(compensationFailedError, {
    message:
      `compensation failed after an append error: ${redactedMessage(trigger)} ` +
      `(rollback: ${redactedMessage(rollback)})`,
    code: ErrorCode.COMPENSATION_FAILED,
    context: {},
    cause: trigger,
    details: { rollbackError: rollback },
  });
}

/**
 * The error for an append-saga chunk whose own outcome could not be
 * established, raised once every chunk this call *could* confirm has already
 * been undone — the rollback itself did not fail; this chunk alone could not
 * be read back, or its write may still be applied after the read.
 *
 * Accepts: `cause` — the failing chunk's own failure. `unsettledBecause` —
 * why its outcome is unknown: the read-back's own failure, or the write's
 * own failure, when some attempt of it may still be applied. Both are built
 * from a `catch`, so either may be whatever a `throw` produced rather than
 * an `Error`.
 *
 * Returns: a `COMPENSATION_FAILED` error carrying `cause` as `cause` and
 * `unsettledBecause` as `details.rollbackError`, each normalised through
 * `toError` so both are always error-shaped. Its message says the chunk's
 * own fate could not be established — never that a rollback failed, since
 * every chunk this call could confirm was already rolled back before this is
 * raised. The session's `messageCount` may have drifted, which
 * `reconcileMessageCount` repairs; the quoted text of both errors is
 * redacted before it is embedded.
 *
 * Throws: nothing; building an error may not fail. Reading `.message` off a
 * thrown `null` or `undefined` would throw here, which is why `toError`
 * normalises both `cause` and `unsettledBecause` before anything reads off
 * them.
 */
export function unsettledAppendError(
  cause: Error,
  unsettledBecause: Error,
): DynamoDBLangGraphError<ErrorCode.COMPENSATION_FAILED> {
  const trigger = toError(cause);
  const unsettled = toError(unsettledBecause);
  return build(unsettledAppendError, {
    message:
      `an append chunk could not be settled after ${redactedMessage(trigger)} ` +
      `(unsettled because: ${redactedMessage(unsettled)})`,
    code: ErrorCode.COMPENSATION_FAILED,
    context: {},
    cause: trigger,
    details: { rollbackError: unsettled },
  });
}
