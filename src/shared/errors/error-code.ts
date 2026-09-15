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
  UPSTREAM = 'UPSTREAM',
}
