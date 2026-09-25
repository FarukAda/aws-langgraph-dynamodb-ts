/**
 * Hides which outcomes a caller can tell apart.
 *
 * Every error this library raises carries one of these codes, and a caller
 * branches on the code rather than on a class, a message or an AWS name. What
 * produces each code is decided elsewhere, so a newly seen AWS failure maps
 * onto an existing code without touching this list, and the list is frozen so
 * no consumer sharing it in a process can change what a comparison means.
 */

/** Stable, branchable classification for every error this library throws. */
export enum ErrorCode {
  VALIDATION = 'VALIDATION',
  /** A row or payload written in a format version newer than this package reads. */
  FORMAT_UNSUPPORTED = 'FORMAT_UNSUPPORTED',
  /**
   * A checkpoint a delta channel still needs has expired, so the channel cannot
   * be reconstructed and the read refuses rather than returning a shorter value.
   */
  ANCESTOR_EXPIRED = 'ANCESTOR_EXPIRED',
  CONDITION_CONFLICT = 'CONDITION_CONFLICT',
  RETRY_EXHAUSTED = 'RETRY_EXHAUSTED',
  BATCH_WRITE_INCOMPLETE = 'BATCH_WRITE_INCOMPLETE',
  COMPRESSION_LIMIT = 'COMPRESSION_LIMIT',
  /**
   * A stored payload's bytes do not match the form its row declares: the row
   * says gzip and they are not, or they are not the serializer's output. The
   * payload can never be read, so it is reported rather than retried.
   */
  PAYLOAD_CORRUPT = 'PAYLOAD_CORRUPT',
  S3_OFFLOAD_FAILED = 'S3_OFFLOAD_FAILED',
  RESULT_TRUNCATED = 'RESULT_TRUNCATED',
  ABORTED = 'ABORTED',
  COMPENSATION_FAILED = 'COMPENSATION_FAILED',
  /**
   * AWS throttled the request: `ProvisionedThroughputExceededException`,
   * `ThrottlingException`, `RequestLimitExceeded`, S3's `SlowDown`, an HTTP
   * 429, or a cancelled transaction whose causes are all transient and include
   * a throttling reason. Back off, or raise the table's capacity or the account
   * quota.
   */
  THROTTLED = 'THROTTLED',
  /**
   * AWS or the network failed transiently: `InternalServerError`,
   * `InternalFailure`, `ServiceUnavailable`, S3's `InternalError`, a request
   * timeout (`RequestTimeout`, `RequestTimeoutException`, the SDK's
   * `TimeoutError`), an HTTP 500/502/503/504, or a reset, refused or
   * unreachable connection. Retry after a backoff. A write that failed this way
   * may still have been applied.
   */
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  /**
   * Another request was writing the same item or object at the same moment:
   * `TransactionConflictException`, `TransactionInProgressException`,
   * `ReplicatedWriteConflictException`, S3's `ConditionalRequestConflict`, or a
   * cancelled transaction whose only transient cause is a conflict. Retry; more
   * capacity would not help.
   */
  CONTENTION = 'CONTENTION',
  /**
   * AWS refused the caller's identity or permissions: `AccessDeniedException`,
   * S3's `AccessDenied`, an expired, unrecognised or malformed credential or
   * signature. Fix the credentials or the IAM policy; do not retry.
   * `context.awsErrorName` says which.
   */
  ACCESS_DENIED = 'ACCESS_DENIED',
  /**
   * The table, index, bucket or object is not there: `ResourceNotFoundException`,
   * S3's `NoSuchBucket` or `NoSuchKey`. Not an absent item — a read of a key that
   * holds nothing returns nothing.
   */
  NOT_FOUND = 'NOT_FOUND',
  /**
   * AWS rejected the request as malformed: `ValidationException`,
   * AWS's `ValidationError` common error, `IdempotentParameterMismatchException`,
   * or a request body it could not read or accept. Retrying the same request
   * fails the same way.
   */
  AWS_REJECTED = 'AWS_REJECTED',
  /** An AWS request failed and no narrower code applies; `context.awsErrorName` names it. */
  AWS_REQUEST_FAILED = 'AWS_REQUEST_FAILED',
  /**
   * A failure that came neither from this package's own checks nor from AWS:
   * a `VectorBackend`, an `Embeddings` model, a `serde` or a `MultiSessionHistory`
   * threw something of its own, or this package has a bug. The original is
   * `cause`.
   */
  UNEXPECTED_ERROR = 'UNEXPECTED_ERROR',
}

// A TypeScript enum compiles to a plain, writable object, and this one is
// exported from the package root: every consumer in a process shares the same
// object. One dependency assigning to a member — a test stub, a patch, a
// typo — rewrites what `error.code === ErrorCode.X` means for every other
// consumer at once, and nothing is raised anywhere; the branch simply stops
// matching. Freezing turns that into a refusal at the assignment.
Object.freeze(ErrorCode);
