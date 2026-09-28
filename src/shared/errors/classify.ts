/**
 * Hides which AWS failures are the same failure.
 *
 * An SDK error arrives as a name, an HTTP status, a Node network `code` or —
 * for a cancelled transaction — a list of per-item reasons, and several of
 * those arrivals mean one thing to a caller deciding what to do. Their mapping
 * to one `ErrorCode`, and the retry layer's default list of transient names,
 * come from one table here (record 19), so no call site compares an AWS
 * exception name of its own.
 */

import {
  conditionalCheckFailure,
  throttledCancellation,
  transientCancellation,
} from '../dynamodb/cancellation';
import type { ErrorContext } from './base-error';
import { ErrorCode } from './error-code';

/** The fields an AWS SDK v3 error, or a transport error under it, can carry. */
interface AwsErrorFields {
  name?: string;
  code?: string;
  $metadata?: { httpStatusCode?: number; requestId?: string } | null;
}

/**
 * The Node.js system error codes the SDK's own retry strategy treats as
 * transient regardless of name (`@smithy/core` retry `NODEJS_TIMEOUT_ERROR_CODES`
 * and `NODEJS_NETWORK_ERROR_CODES`). Matched on the error's own `code`.
 */
export const TRANSIENT_NETWORK_ERROR_CODES: readonly string[] = [
  'ECONNRESET',
  'ECONNREFUSED',
  'EPIPE',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
];

/**
 * HTTP statuses the SDK retries regardless of name: throttling (429) and the
 * transient server statuses (`@smithy/core` retry `TRANSIENT_ERROR_STATUS_CODES`).
 * They classify an error the SDK could not map to a modeled exception, which
 * arrives as `name: 'Unknown'` with only its status.
 */
export const TRANSIENT_HTTP_STATUSES: readonly number[] = [429, 500, 502, 503, 504];

/** The status S3 answers a failed `If-None-Match: *` precondition with. */
const PRECONDITION_FAILED_STATUS = 412;

const TRANSACTION_CANCELLED = 'TransactionCanceledException';

/**
 * AWS error name to code. Each name is declared by the installed
 * `@aws-sdk/client-dynamodb` or `@aws-sdk/client-s3`, or documented on a page
 * `test/static/aws-error-names.test.ts` cites; that test fails on any other.
 */
export const AWS_ERROR_CODES: Readonly<Record<string, ErrorCode>> = {
  ProvisionedThroughputExceededException: ErrorCode.THROTTLED,
  ThrottlingException: ErrorCode.THROTTLED,
  RequestLimitExceeded: ErrorCode.THROTTLED,
  SlowDown: ErrorCode.THROTTLED,

  InternalServerError: ErrorCode.SERVICE_UNAVAILABLE,
  InternalFailure: ErrorCode.SERVICE_UNAVAILABLE,
  ServiceUnavailable: ErrorCode.SERVICE_UNAVAILABLE,
  InternalError: ErrorCode.SERVICE_UNAVAILABLE,
  RequestTimeout: ErrorCode.SERVICE_UNAVAILABLE,
  RequestTimeoutException: ErrorCode.SERVICE_UNAVAILABLE,
  TimeoutError: ErrorCode.SERVICE_UNAVAILABLE,

  TransactionConflictException: ErrorCode.CONTENTION,
  TransactionInProgressException: ErrorCode.CONTENTION,
  ReplicatedWriteConflictException: ErrorCode.CONTENTION,
  /**
   * S3's `409` on a conditional write whose key was deleted between the check
   * and the write; the S3 User Guide's remedy on `PutObject` is to retry the
   * upload (*How to prevent object overwrites with conditional writes*,
   * "Conditional write behavior").
   */
  ConditionalRequestConflict: ErrorCode.CONTENTION,

  AccessDeniedException: ErrorCode.ACCESS_DENIED,
  AccessDenied: ErrorCode.ACCESS_DENIED,
  ExpiredTokenException: ErrorCode.ACCESS_DENIED,
  ExpiredToken: ErrorCode.ACCESS_DENIED,
  IncompleteSignature: ErrorCode.ACCESS_DENIED,
  IncompleteSignatureException: ErrorCode.ACCESS_DENIED,
  InvalidAccessKeyId: ErrorCode.ACCESS_DENIED,
  MissingAuthenticationTokenException: ErrorCode.ACCESS_DENIED,
  NotAuthorized: ErrorCode.ACCESS_DENIED,
  SignatureDoesNotMatch: ErrorCode.ACCESS_DENIED,
  UnrecognizedClientException: ErrorCode.ACCESS_DENIED,

  ResourceNotFoundException: ErrorCode.NOT_FOUND,
  NoSuchBucket: ErrorCode.NOT_FOUND,
  NoSuchKey: ErrorCode.NOT_FOUND,
  NoSuchLifecycleConfiguration: ErrorCode.NOT_FOUND,

  ValidationException: ErrorCode.AWS_REJECTED,
  ValidationError: ErrorCode.AWS_REJECTED,
  IdempotentParameterMismatchException: ErrorCode.AWS_REJECTED,
  MalformedHttpRequestException: ErrorCode.AWS_REJECTED,
  RequestEntityTooLargeException: ErrorCode.AWS_REJECTED,

  ConditionalCheckFailedException: ErrorCode.CONDITION_CONFLICT,
  PreconditionFailed: ErrorCode.CONDITION_CONFLICT,

  /** An item collection past 10 GB: neither a retry nor a changed request helps; an operator must act. */
  ItemCollectionSizeLimitExceededException: ErrorCode.AWS_REQUEST_FAILED,
  /** Endpoint discovery is not used by this package, so this is reported rather than acted on. */
  InvalidEndpointException: ErrorCode.AWS_REQUEST_FAILED,
  /** Its reasons are read first; this is the answer when they settle nothing. */
  TransactionCanceledException: ErrorCode.AWS_REQUEST_FAILED,

  /**
   * Read by name, not from the caller's signal: a collaborator — a
   * `vectorBackend`, `index.embeddings` — rejecting with an `AbortError` from
   * its own timeout is `ABORTED` too, even when the caller's signal never fired.
   */
  AbortError: ErrorCode.ABORTED,
};

/** The codes a caller retries after a backoff. */
const RETRYABLE_CODES: readonly ErrorCode[] = [
  ErrorCode.THROTTLED,
  ErrorCode.SERVICE_UNAVAILABLE,
  ErrorCode.CONTENTION,
];

/**
 * The retry layer's default tokens: every name {@link AWS_ERROR_CODES} maps to
 * a retryable code, and the network codes. Derived rather than listed, so the
 * retry layer and the code a caller sees share one list of transient names.
 * They differ at two edges: the retry layer also retries on the SDK's
 * `$retryable` trait, which {@link classifyAwsError} does not read, and it
 * walks the cause chain matching `errno` and `syscall` too, where the
 * classifier reads one error's `name`, `code` and status.
 */
export const DEFAULT_RETRYABLE_ERRORS: readonly string[] = [
  ...Object.entries(AWS_ERROR_CODES)
    .filter(([, code]) => RETRYABLE_CODES.includes(code))
    .map(([name]) => name),
  ...TRANSIENT_NETWORK_ERROR_CODES,
];

/** The table's code for `name`; `undefined` for any other value, never read through the prototype. */
function declaredCodeOf(name: string | undefined): ErrorCode | undefined {
  return typeof name === 'string' && Object.hasOwn(AWS_ERROR_CODES, name)
    ? AWS_ERROR_CODES[name]
    : undefined;
}

/** The response's HTTP status, when the error carries well-typed `$metadata`. */
function statusOf(fields: AwsErrorFields): number | undefined {
  const metadata = fields.$metadata;
  return typeof metadata === 'object' &&
    metadata !== null &&
    typeof metadata.httpStatusCode === 'number'
    ? metadata.httpStatusCode
    : undefined;
}

/** Whether the error carries the SDK's `$metadata`, or a name the table knows or that ends in `Exception`. */
function isAwsShaped(fields: AwsErrorFields): boolean {
  if (typeof fields.$metadata === 'object' && fields.$metadata !== null) return true;
  const { name } = fields;
  return (
    typeof name === 'string' && (declaredCodeOf(name) !== undefined || name.endsWith('Exception'))
  );
}

/** The code of a cancelled transaction, read from its reasons. */
function cancellationCode(error: Error): ErrorCode {
  if (conditionalCheckFailure(error) !== undefined) return ErrorCode.CONDITION_CONFLICT;
  if (transientCancellation(error) === true) {
    return throttledCancellation(error) ? ErrorCode.THROTTLED : ErrorCode.CONTENTION;
  }
  return AWS_ERROR_CODES[TRANSACTION_CANCELLED];
}

/**
 * The code a failure that is not one of this library's own belongs to.
 *
 * Accepts: anything a `catch` can bind — an SDK error, a transport error, a
 * value from caller-supplied code, `null`, a string.
 *
 * Returns: a transaction cancellation's code from its reasons (a sole
 * `ConditionalCheckFailed` cause is `CONDITION_CONFLICT`; all-transient causes
 * are `THROTTLED` or `CONTENTION`); otherwise the table's code for the error's
 * own `name`; otherwise `SERVICE_UNAVAILABLE` for a transient network `code`;
 * otherwise by HTTP status — 412 `CONDITION_CONFLICT`, 429 `THROTTLED`,
 * 500/502/503/504 `SERVICE_UNAVAILABLE`; otherwise `AWS_REQUEST_FAILED` for an
 * AWS-shaped error and `UNEXPECTED_ERROR` for anything else. Only the error's
 * own fields are read, never its `cause`.
 *
 * Throws: nothing, for any value. It runs inside `catch` blocks.
 */
export function classifyAwsError(error: Error): ErrorCode {
  if (typeof error !== 'object' || error === null) return ErrorCode.UNEXPECTED_ERROR;
  const fields = error as AwsErrorFields;
  if (fields.name === TRANSACTION_CANCELLED) return cancellationCode(error);
  const declared = declaredCodeOf(fields.name);
  if (declared !== undefined) return declared;
  if (typeof fields.code === 'string' && TRANSIENT_NETWORK_ERROR_CODES.includes(fields.code)) {
    return ErrorCode.SERVICE_UNAVAILABLE;
  }
  const status = statusOf(fields);
  if (status === PRECONDITION_FAILED_STATUS) return ErrorCode.CONDITION_CONFLICT;
  if (status === 429) return ErrorCode.THROTTLED;
  if (status !== undefined && TRANSIENT_HTTP_STATUSES.includes(status)) {
    return ErrorCode.SERVICE_UNAVAILABLE;
  }
  return isAwsShaped(fields) ? ErrorCode.AWS_REQUEST_FAILED : ErrorCode.UNEXPECTED_ERROR;
}

/**
 * The fields an operator needs first, lifted off an AWS-shaped error.
 *
 * Accepts: anything a `catch` can bind.
 *
 * Returns: `awsErrorName`, `requestId` and `httpStatusCode`, each only when
 * present and well-typed, for an error carrying `$metadata` or a name the table
 * knows or that ends in `Exception`; `{}` for anything else — a bare network
 * failure included, since it may be a caller's own connection rather than AWS's.
 *
 * Throws: nothing, for any value.
 */
export function awsDiagnostics(
  error: Error,
): Pick<ErrorContext, 'awsErrorName' | 'requestId' | 'httpStatusCode'> {
  if (typeof error !== 'object' || error === null) return {};
  const fields = error as AwsErrorFields;
  if (!isAwsShaped(fields)) return {};
  const out: Pick<ErrorContext, 'awsErrorName' | 'requestId' | 'httpStatusCode'> = {};
  if (typeof fields.name === 'string') out.awsErrorName = fields.name;
  const status = statusOf(fields);
  if (status !== undefined) out.httpStatusCode = status;
  const requestId = fields.$metadata?.requestId;
  if (typeof requestId === 'string') out.requestId = requestId;
  return out;
}

/** The names the SDK gives a request it cut short itself, before any response. */
const CLIENT_SIDE_CUTS: readonly string[] = ['TimeoutError', 'AbortError'];

/** How far {@link endedWithoutAnswer} walks a cause chain before giving up. */
const MAX_ANSWER_DEPTH = 8;

/**
 * Whether a failed request ended on this side, before the service answered it.
 *
 * Accepts: anything a `catch` can bind, and `undefined`.
 *
 * Returns: true when the failure, or a cause beneath it, is a cut this side
 * made — the SDK's own `TimeoutError` or `AbortError`, or a Node network error
 * such as `ECONNRESET` or `ETIMEDOUT` — and no node on the way carries the HTTP
 * status of a response. The service may still apply a request cut that way
 * after the caller has stopped waiting for it. False for everything else: a
 * failure the service answered, and one that says nothing about the transport,
 * such as a value a caller's own code threw. A cycle in the chain ends the walk.
 *
 * Throws: nothing, for any value.
 */
export function endedWithoutAnswer(error: Error | undefined): boolean {
  const seen = new WeakSet<object>();
  let node: Error | undefined = error;
  for (let depth = 0; depth < MAX_ANSWER_DEPTH; depth += 1) {
    if (typeof node !== 'object' || node === null || seen.has(node)) return false;
    seen.add(node);
    const fields = node as AwsErrorFields;
    if (statusOf(fields) !== undefined) return false;
    if (typeof fields.name === 'string' && CLIENT_SIDE_CUTS.includes(fields.name)) return true;
    if (typeof fields.code === 'string' && TRANSIENT_NETWORK_ERROR_CODES.includes(fields.code)) {
      return true;
    }
    node = (node as { cause?: Error }).cause;
  }
  return false;
}

/**
 * The name DynamoDB answers with when a `TransactWriteItems` request under a
 * `ClientRequestToken` still in use finds its own earlier attempt under that
 * token still being processed.
 */
const TRANSACTION_IN_PROGRESS = 'TransactionInProgressException';

/** The lowest and highest HTTP server-error status, inclusive. */
const SERVER_ERROR_STATUS_MIN = 500;
const SERVER_ERROR_STATUS_MAX = 599;

/**
 * Whether one attempt's own failure leaves DynamoDB free to apply it later,
 * judged from that attempt alone.
 *
 * Accepts: anything a `catch` can bind, and `undefined`.
 *
 * Returns: true when the attempt {@link endedWithoutAnswer}; when the service
 * answered that its own earlier attempt under the same `ClientRequestToken`
 * was still being processed (`TransactionInProgressException`); or when it
 * answered with a server error, an HTTP 5xx — which AWS documents as leaving a
 * write's outcome undecided rather than refused (`TransactWriteItems` API
 * reference, *Errors*: a 500 "may have succeeded or failed", with no later
 * point documented as settling it). False for a refusal, a throttle, or any
 * other definite answer.
 *
 * Throws: nothing, for any value.
 */
export function mayStillBeInFlight(error: Error | undefined): boolean {
  if (endedWithoutAnswer(error)) return true;
  if (typeof error !== 'object' || error === null) return false;
  const fields = error as AwsErrorFields;
  if (fields.name === TRANSACTION_IN_PROGRESS) return true;
  const status = statusOf(fields);
  return (
    status !== undefined && status >= SERVER_ERROR_STATUS_MIN && status <= SERVER_ERROR_STATUS_MAX
  );
}

/** The codes of a failure the service answered by refusing the request, of which it applied nothing. */
const REFUSED: readonly ErrorCode[] = [
  ErrorCode.AWS_REJECTED,
  ErrorCode.ACCESS_DENIED,
  ErrorCode.NOT_FOUND,
  ErrorCode.CONDITION_CONFLICT,
];

/**
 * Whether the service refused a request outright, so that none of it was applied.
 *
 * Accepts: anything a `catch` can bind.
 *
 * Returns: true for a cancelled transaction — DynamoDB applies none of a
 * transaction it cancels — and for a failure the classifier places under a
 * refusal: a malformed request, a denied permission, a missing table or index,
 * a failed condition. False for everything else, a spent retry budget and a
 * cancel included, since neither says what the service did.
 *
 * Throws: nothing, for any value.
 */
export function refusedByService(error: Error): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ((error as AwsErrorFields).name === TRANSACTION_CANCELLED) return true;
  return REFUSED.includes(classifyAwsError(error));
}

/**
 * Whether an S3 read failed because the object is gone.
 *
 * Accepts: anything a `catch` can bind.
 *
 * Returns: true for `NoSuchKey` only. `NOT_FOUND` also covers a missing
 * bucket, which is a configuration fault; reading it as a lost payload would
 * write off data that is still there.
 *
 * Throws: nothing, for any value.
 */
export function isMissingObject(error: Error): boolean {
  return (
    typeof error === 'object' && error !== null && (error as AwsErrorFields).name === 'NoSuchKey'
  );
}

/**
 * Whether reading a bucket's lifecycle configuration failed because the bucket
 * has none.
 *
 * Accepts: anything a `catch` can bind.
 *
 * Returns: true for `NoSuchLifecycleConfiguration` only. `NOT_FOUND` also
 * covers a missing bucket, table or object; reading one of those as "no rules
 * yet" would start a rule set for a bucket that is not there.
 *
 * Throws: nothing, for any value.
 */
export function isMissingLifecycleConfiguration(error: Error): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as AwsErrorFields).name === 'NoSuchLifecycleConfiguration'
  );
}
