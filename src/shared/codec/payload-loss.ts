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

/**
 * True when a row's payload descriptor is not one this adapter can read: it is
 * absent, it is not an object, or its shape is one this version does not
 * understand. The row condemns its own payload — no retry and no configuration
 * change makes those bytes readable, and no other reader would fare better.
 *
 * A `ValidationError` naming `s3Key` is deliberately *not* matched here: it
 * says the reader may not follow the key, not that the payload is unreadable
 * (see `assertKeyInScope`).
 */
function isUnreadableDescriptor(error: Error): boolean {
  const coded = error as { code?: string; context?: { field?: string } };
  return coded.code === ErrorCode.VALIDATION && coded.context?.field === 'descriptor';
}

/**
 * True when a payload can never be read again, as opposed to a failure that may
 * succeed on retry or after a configuration fix (throttling, network,
 * permissions).
 *
 * Accepts: `error` — any error. Permanent are: its object is gone
 * ({@link isMissingObjectError}), its bytes are not the form the row declares
 * (`PAYLOAD_CORRUPT`), it trips the decompression guard (`COMPRESSION_LIMIT`),
 * or the row's own descriptor is unreadable ({@link isUnreadableDescriptor}).
 * Everything else is false, including an error that carries no code at all, and
 * including the `s3Key` scope refusal — a row pointing outside its own path is
 * a configuration or tenancy fault to report, not a payload to write off.
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
    isUnreadableDescriptor(error)
  );
}
