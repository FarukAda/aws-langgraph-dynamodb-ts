import type { WriteRequest } from '../dynamodb/types';
import { ErrorCode } from './error-code';

const ERROR_BRAND = Symbol.for('@farukada/aws-langgraph-dynamodb-ts/error');

/**
 * Structured, log-safe context attached to every library error. Identifiers
 * and counts only — never a payload or a credential.
 */
export interface ErrorContext {
  /** The DynamoDB table the operation targeted, when known. */
  tableName?: string;
  /** The public operation (`saver.put`, `store.batch`, …) or internal step that failed. */
  operation?: string;
  /** The option, argument or cap that failed validation or was exceeded. */
  field?: string;
  /** The S3 object key involved, for offload failures. */
  key?: string;
  /** Attempts made before a retry budget was exhausted. */
  attempts?: number;
  /** The thread a checkpointer failure belongs to. */
  threadId?: string;
  /** The checkpoint a checkpointer failure names. */
  checkpointId?: string;
  /**
   * The AWS exception name of the failure underneath, when that failure was
   * AWS-shaped (it carried the SDK's `$metadata`, or a name the classifier
   * knows or that ends in `Exception`). Lifted off `cause.name` so a log line
   * or an alert can branch on it without walking `cause`.
   */
  awsErrorName?: string;
  /** The AWS request id (`cause.$metadata.requestId`), which AWS Support asks for. */
  requestId?: string;
  /** The HTTP status of the failed AWS response (`cause.$metadata.httpStatusCode`). */
  httpStatusCode?: number;
}

/** What one `BatchWriteItem` drain left behind when it ran out of rounds. */
export interface BatchDrainDetails {
  readonly kind: 'drain';
  /** Writes DynamoDB acknowledged; they persist, since there is no rollback. */
  readonly succeededCount: number;
  /** The requests DynamoDB did not acknowledge, verbatim, so they can be re-submitted. */
  readonly unprocessed: readonly WriteRequest[];
  /** `UnprocessedItems` rounds spent. */
  readonly retries: number;
}

/**
 * The tally of a pass that attempted every chunk (`unit: 'chunk'`, 25-row
 * `BatchWriteItem` chunks) or every row (`unit: 'row'`, one conditional delete
 * per row) before reporting.
 */
export interface BatchPassDetails {
  readonly kind: 'pass';
  readonly unit: 'chunk' | 'row';
  readonly succeededChunks: number;
  readonly totalChunks: number;
  /** Each failing chunk's or row's own error. */
  readonly failedChunks: readonly Error[];
  /** Individual writes confirmed persisted across the whole pass. */
  readonly succeededCount: number;
}

/** What a `BATCH_WRITE_INCOMPLETE` error reports: one drain, or a whole pass. */
export type BatchWriteIncompleteDetails = BatchDrainDetails | BatchPassDetails;

/** What a `COMPENSATION_FAILED` error reports besides its trigger, which is `cause`. */
export interface CompensationFailedDetails {
  /** Why the rollback itself could not finish; itself often a `BATCH_WRITE_INCOMPLETE`. */
  readonly rollbackError: Error;
}

/** The codes that carry details, and the shape each one carries. */
export interface ErrorDetailsByCode {
  [ErrorCode.BATCH_WRITE_INCOMPLETE]: BatchWriteIncompleteDetails;
  [ErrorCode.COMPENSATION_FAILED]: CompensationFailedDetails;
}

/** The details a code carries; `undefined` for every code not in {@link ErrorDetailsByCode}. */
export type ErrorDetailsFor<C extends ErrorCode> = C extends keyof ErrorDetailsByCode
  ? ErrorDetailsByCode[C]
  : undefined;

/**
 * A shallow copy of `details` with every array copied too, so a caller reusing
 * its request buffer or failure list cannot rewrite what the error reported.
 * Anything that is not an object is returned as it is: building an error may
 * not fail.
 */
function copyDetails<D>(details: D): D {
  if (details === null || typeof details !== 'object') return details;
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
  ) as D;
}

/**
 * Base class for every error this library throws. Carries a branchable
 * {@link ErrorCode}, structured {@link ErrorContext}, code-specific
 * {@link details}, and a native `cause` chain. Detected via
 * {@link isDynamoDBLangGraphError} (a symbol brand) rather than `instanceof`,
 * which is banned repo-wide.
 */
export class DynamoDBLangGraphError<C extends ErrorCode = ErrorCode> extends Error {
  readonly code: C;
  readonly context: ErrorContext;
  /** Declared, not emitted: a code without details leaves no `undefined`-valued own property. */
  declare readonly details: ErrorDetailsFor<C>;

  /**
   * Accepts: `message` — already redacted by whoever composed it, since it reaches
   * `err.message`, which an application may print without a redacting logger.
   * `code` — the code this error branches on. `context` — identifiers and counts
   * only, never a payload or a credential. It is **copied**, so a caller that
   * reuses one builder object cannot rewrite the context of an error already in
   * flight; `null` reads as an absent one. `cause` — the failure below this one,
   * kept as the native `cause` chain. `details` — the code-specific record
   * {@link ErrorDetailsByCode} names, copied like `context`.
   *
   * Returns: the error, branded so {@link isDynamoDBLangGraphError} recognises it
   * across realms and across two copies of this package. The brand is
   * non-enumerable, so it never reaches a log or a JSON serialization.
   *
   * Throws: nothing; building an error may not fail.
   */
  constructor(
    message: string,
    code: C,
    context: ErrorContext = {},
    cause?: Error,
    details?: ErrorDetailsFor<C>,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'DynamoDBLangGraphError';
    this.code = code;
    this.context = { ...context };
    if (details !== undefined) this.details = copyDetails(details);
    Object.defineProperty(this, ERROR_BRAND, { value: true, enumerable: false });
  }
}

/**
 * Every library error, as a union discriminated by `code`: comparing `code`
 * narrows `details` to the shape that code carries.
 */
export type AnyDynamoDBLangGraphError = { [C in ErrorCode]: DynamoDBLangGraphError<C> }[ErrorCode];

/**
 * Whether `value` is one of this library's errors.
 *
 * Accepts: any error, from any realm or any copy of this package — and, since
 * the documented place to call this is inside a `catch`, any other value a
 * `throw` can produce: `null`, `undefined`, a string, a number, a symbol.
 *
 * Returns: whether it carries the brand, narrowed to the union discriminated by
 * `code`. A symbol registered by name, not `instanceof`: two copies of this
 * package in one dependency tree produce two classes but one symbol, and an
 * error crossing a realm boundary keeps its properties while losing its
 * prototype. Anything that cannot carry a property answers `false`.
 *
 * Throws: nothing. The `in` operator raises a `TypeError` on a non-object, and
 * a guard that throws inside the `catch` it was called from would replace the
 * failure the caller is reporting with one of its own.
 */
export function isDynamoDBLangGraphError(value: Error): value is AnyDynamoDBLangGraphError {
  return typeof value === 'object' && value !== null && ERROR_BRAND in value;
}

/**
 * Whether `value` is one of this library's errors carrying `code`.
 *
 * Accepts: anything a `catch` can bind. `code` — the code to test for.
 *
 * Returns: `true` only for a branded error whose `code` is `code`, narrowed so
 * its `details` are typed. An unbranded object that merely carries a `code`
 * property is not one: recognition is by brand and code together, never by a
 * name or a shape.
 *
 * Throws: nothing, for any value.
 */
export function hasErrorCode<C extends ErrorCode>(
  value: Error,
  code: C,
): value is DynamoDBLangGraphError<C> {
  return isDynamoDBLangGraphError(value) && value.code === code;
}

/**
 * What a log line calls a failure.
 *
 * Accepts: any error a `catch` bound.
 *
 * Returns: the `code` of one of this library's errors, and the `name` of any
 * other. Every library error shares one name, so the name alone would log
 * `DynamoDBLangGraphError` for a refused input and a spent retry budget alike;
 * the code is what tells them apart, and like a name it is an identifier, never
 * a payload.
 *
 * Throws: nothing for an error. A value that cannot carry a property raises
 * the `TypeError` reading its `name` raises, as reading it directly would.
 */
export function failureLabel(error: Error): string {
  return isDynamoDBLangGraphError(error) ? error.code : error.name;
}
