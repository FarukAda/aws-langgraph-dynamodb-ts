import { ErrorCode } from '../errors/error-code';

/**
 * True when an offloaded object no longer exists.
 *
 * Accepts: `error` — any error; only `S3_OFFLOAD_FAILED` carrying a `NoSuchKey`
 * cause matches. An error with no `cause`, or one whose cause names another
 * S3 failure, is not a missing object.
 *
 * Returns: whether the object is gone — a lifecycle sweep removed it, or a
 * competing overwrite deleted it between a row read and the download.
 *
 * Throws: nothing.
 */
export function isMissingObjectError(error: Error): boolean {
  const coded = error as { code?: string; cause?: { name?: string } };
  return coded.code === ErrorCode.S3_OFFLOAD_FAILED && coded.cause?.name === 'NoSuchKey';
}

/** Validation fields that condemn the row itself rather than the caller's input. */
const ROW_REJECTION_FIELDS: readonly string[] = ['s3Key', 'descriptor'];

/**
 * True when a row's descriptor can never be read by this adapter: its key lies
 * outside the S3 path its own identifiers allow (see `assertKeyInScope`), or
 * its shape is one this version does not understand.
 */
function isRowRejection(error: Error): boolean {
  const coded = error as { code?: string; context?: { field?: string } };
  return (
    coded.code === ErrorCode.VALIDATION &&
    coded.context?.field !== undefined &&
    ROW_REJECTION_FIELDS.includes(coded.context.field)
  );
}

/**
 * True when a payload can never be read again, as opposed to a failure that may
 * succeed on retry or after a configuration fix (throttling, network,
 * permissions).
 *
 * Accepts: `error` — any error. Permanent are: its object is gone
 * ({@link isMissingObjectError}), its bytes are not the form the row declares
 * (`PAYLOAD_CORRUPT`), it trips the decompression guard (`COMPRESSION_LIMIT`),
 * or the row's own key lies outside the path its identifiers allow
 * ({@link isRowRejection}). Everything else is false, including an error that
 * carries no code at all.
 *
 * Returns: whether a caller should report rather than retry.
 *
 * Throws: nothing.
 */
export function isPermanentPayloadLoss(error: Error): boolean {
  const coded = error as { code?: string };
  return (
    coded.code === ErrorCode.COMPRESSION_LIMIT ||
    coded.code === ErrorCode.PAYLOAD_CORRUPT ||
    isMissingObjectError(error) ||
    isRowRejection(error)
  );
}
