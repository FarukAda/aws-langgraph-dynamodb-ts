import { ErrorCode } from '../errors/error-code';

/**
 * True when an offloaded object no longer exists — a lifecycle sweep removed
 * it, or a competing overwrite deleted it between a row read and the download.
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
 * True when a payload can never be read again — its object is gone, it trips
 * the decompression guard, or its key lies outside the row's own path — as
 * opposed to a failure that may succeed on retry or after a configuration fix
 * (throttling, network, permissions).
 */
export function isPermanentPayloadLoss(error: Error): boolean {
  const coded = error as { code?: string };
  return (
    coded.code === ErrorCode.COMPRESSION_LIMIT ||
    isMissingObjectError(error) ||
    isRowRejection(error)
  );
}
