import { hasErrorCode } from '../errors/base-error';
import { isMissingObject } from '../errors/classify';
import { ErrorCode } from '../errors/error-code';

/**
 * True when an offloaded object no longer exists.
 *
 * Accepts: `error` — any error; only `S3_OFFLOAD_FAILED` carrying a `NoSuchKey`
 * cause matches. An error with no `cause`, or one whose cause names another
 * S3 failure, is not a missing object. Anything else a `throw` can produce —
 * `null`, `undefined`, a primitive — carries no code and is not one either.
 *
 * Returns: whether the object is gone — a lifecycle sweep removed it, or a
 * competing overwrite deleted it between a row read and the download.
 *
 * Throws: **nothing**, for any value. A caught value that cannot carry a
 * property answers `false`, as `isDynamoDBLangGraphError` does, rather than
 * raising a `TypeError` inside the `catch` that is reporting the download
 * failure this test exists to classify.
 */
export function isMissingObjectError(error: Error): boolean {
  return (
    hasErrorCode(error, ErrorCode.S3_OFFLOAD_FAILED) &&
    error.cause !== undefined &&
    isMissingObject(error.cause as Error)
  );
}

/**
 * True when a row's payload descriptor is not one *any* reader could make sense
 * of: it is absent, it is not an object, or it names a location no release of
 * this library ever wrote at the schema it declares. The row condemns its own
 * payload — no retry and no configuration change makes those bytes readable,
 * and no other reader would fare better.
 *
 * Two refusals from the same guard are deliberately *not* matched here, both
 * because the sentence above would be false of them. A `ValidationError` naming
 * `s3Key` says the reader may not follow the key, not that the payload is
 * unreadable (see `assertKeyInScope`). A `FORMAT_UNSUPPORTED` naming
 * `schemaVersion` says the payload was written by a newer release — which reads
 * it perfectly — so it is the one descriptor refusal a newer reader *does* fare
 * better on, and writing it off silently dropped turns during a rollback or a
 * canary (see `assertReadableDescriptor`).
 */
function isUnreadableDescriptor(error: Error): boolean {
  return hasErrorCode(error, ErrorCode.VALIDATION) && error.context.field === 'descriptor';
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
 * including three refusals that look like loss and are not. The `s3Key` scope
 * refusal: a row pointing outside its own path is a configuration or tenancy
 * fault to report, not a payload to write off. The `serde` refusal, on the same
 * reasoning: the bytes are checked against the form the row declares before
 * that code is chosen, so reaching it means they are undamaged and a serializer
 * declining to reconstruct the class they name says what *this* reader may do,
 * not what the payload is (see `loadPayloadValue`). And `FORMAT_UNSUPPORTED`,
 * on a row or on a payload: newer is not lost.
 *
 * Returns: whether a caller should report rather than retry.
 *
 * Throws: **nothing**, for any value a `throw` can produce. One that cannot
 * carry a code is not permanent loss, which is the same answer an uncoded
 * `Error` gets.
 */
export function isPermanentPayloadLoss(error: Error): boolean {
  return (
    hasErrorCode(error, ErrorCode.COMPRESSION_LIMIT) ||
    hasErrorCode(error, ErrorCode.PAYLOAD_CORRUPT) ||
    isMissingObjectError(error) ||
    isUnreadableDescriptor(error)
  );
}
