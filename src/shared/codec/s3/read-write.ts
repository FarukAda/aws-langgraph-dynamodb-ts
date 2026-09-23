import type { S3Client, ServerSideEncryption } from '@aws-sdk/client-s3';

import { isAbortError } from '../../dynamodb/abort';
import { withRetry, isTransientS3Error } from '../../dynamodb/retry';
import { DynamoDBLangGraphError } from '../../errors/base-error';
import { classifyAwsError } from '../../errors/classify';
import { ErrorCode } from '../../errors/error-code';
import { redactedMessage } from '../../logging/secret-patterns';
import { truncateForLog } from '../../logging/truncate';
import { oversizedObjectError, readBodyBounded } from './bounded-body';
import { loadS3Sdk } from './client';

/** Parameters for {@link uploadObject}. */
export interface UploadParams {
  bucket: string;
  key: string;
  data: Uint8Array;
  serverSideEncryption?: string;
  sseKmsKeyId?: string;
  /** User metadata stored on the object, used for the DynamoDB backlink. */
  metadata?: Record<string, string>;
  /** The caller's cancellation; absent, the upload cannot be interrupted. */
  signal?: AbortSignal;
}

/**
 * Re-throw a cancel as it is, before anything rebrands it.
 *
 * Both wrappers turn every failure into `S3_OFFLOAD_FAILED`, which is right
 * for a failure and wrong for a stop the caller asked for: a cancelled
 * `getMessages` would report that its payload could not be offloaded. The
 * check has to sit ahead of the wrapping rather than inside the classifier,
 * because by then `withRetry` has already decided this is a cancel and said
 * so with the only code a caller branches on.
 */
function rethrowIfCancelled(error: Error): void {
  if (isAbortError(error)) throw error;
}

/**
 * True when S3 refused a conditional write because the key is already taken.
 *
 * With `If-None-Match: *` that is a `412 Precondition Failed` (S3 User Guide,
 * *How to prevent object overwrites with conditional writes*). A key names one
 * write's upload, and only that upload's own requests write it, so the object
 * already there was stored by an earlier attempt of this upload. The upload
 * has nothing left to do, and the 412 is the success case, not a failure. The
 * classifier maps both `PreconditionFailed` and a bare 412 to the same code.
 */
function alreadyStored(error: Error): boolean {
  return classifyAwsError(error) === ErrorCode.CONDITION_CONFLICT;
}

/**
 * Upload `data` to S3 unless an object already exists under `key`, wrapping
 * failures as `S3_OFFLOAD_FAILED`.
 *
 * The write is conditional (`If-None-Match: *`), which costs nothing extra: it
 * needs only `s3:PutObject`, the permission this package already requires, and
 * a retried request writes nothing new: it can never overwrite the object an
 * earlier attempt stored. A `409 Conflict` — S3's answer when a delete lands
 * between the check and the write — is classified as transient and retried
 * like any other conflict.
 *
 * Accepts: `params.key` — the key of one write's upload of `params.data`,
 * written by no other write. `params.metadata` — the backlink, sent with every
 * attempt; an object an earlier attempt stored keeps that attempt's metadata,
 * which is the same. `params.signal` — cancels the request in flight, not only
 * the wait before the next attempt.
 *
 * Returns: nothing, both when this request stored the object and when S3
 * answered `412` because an earlier attempt of this upload already had. The
 * two are not distinguished because the caller's obligation is identical: the
 * bytes are at that key.
 *
 * Throws: `ABORTED` when the signal fires, unwrapped; `S3_OFFLOAD_FAILED`
 * carrying the key and the underlying error, after three attempts on a
 * transient failure. Its message quotes the SDK's, with credential shapes
 * redacted — a signing failure names the key it signed with, and this message
 * reaches `err.message` on a public error.
 *
 * Guarantees: a cancelled upload leaves at most the object it was writing, at
 * a key ending in this write's own object id, which no row names because the
 * row that would have named it is written afterwards. The conditional write
 * means it can never have replaced anything. It is an orphan of exactly the
 * kind `ensureS3LifecycleRule` sweeps, never a corrupted or half-written
 * object: S3 stores a single `PutObject` whole or not at all.
 */
export async function uploadObject(client: S3Client, params: UploadParams): Promise<void> {
  const { PutObjectCommand } = await loadS3Sdk();
  try {
    await withRetry(
      (request) =>
        client.send(
          new PutObjectCommand({
            Bucket: params.bucket,
            Key: params.key,
            Body: params.data,
            ContentType: 'application/octet-stream',
            IfNoneMatch: '*',
            ServerSideEncryption: params.serverSideEncryption as ServerSideEncryption | undefined,
            ...(params.sseKmsKeyId ? { SSEKMSKeyId: params.sseKmsKeyId } : {}),
            ...(params.metadata ? { Metadata: params.metadata } : {}),
          }),
          request,
        ),
      { maxAttempts: 3, isRetryable: isTransientS3Error, signal: params.signal },
    );
  } catch (error) {
    if (alreadyStored(error as Error)) return;
    rethrowIfCancelled(error as Error);
    throw new DynamoDBLangGraphError(
      redactedMessage(error as Error),
      ErrorCode.S3_OFFLOAD_FAILED,
      { operation: 'upload', key: params.key },
      error as Error,
    );
  }
}

/**
 * The bytes stored under `key`.
 *
 * Accepts: `maxBytes` — the largest object this call will buffer. `signal` —
 * cancels the request, and with it a body already streaming.
 *
 * Returns: the object's bytes.
 *
 * Throws: `ABORTED` when the signal fires, unwrapped; `S3_OFFLOAD_FAILED`
 * naming the key — for an object over `maxBytes`, for a response with no body,
 * and for any SDK failure that survives the retries. Its message quotes the
 * underlying one with credential shapes redacted; the SDK error is kept as
 * `cause`, so `NoSuchKey` stays distinguishable
 * ({@link isMissingObjectError}).
 *
 * Guarantees: an object over the cap is refused from its declared
 * `ContentLength` before the body is touched, and while streaming when the
 * length is absent, so a replaced or hostile object cannot exhaust memory.
 * Transient failures are retried by this package alone — the client is built
 * with `maxAttempts: 1`.
 *
 * The body is read *inside* the retried attempt, so the signal covers the
 * whole transfer rather than only the round trip to the headers. A signal that
 * fires mid-body destroys the socket, and the stream rejects with a transport
 * error that every classifier here reads as transient; it never reaches that
 * classification, because the signal is read first. A cancelled download
 * leaves nothing behind at all — no local file, no partial object, and the
 * chunks already buffered are dropped with the call.
 */
export async function downloadObject(
  client: S3Client,
  bucket: string,
  key: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const { GetObjectCommand } = await loadS3Sdk();
  try {
    return await withRetry(
      async (request) => {
        const response = await client.send(
          new GetObjectCommand({ Bucket: bucket, Key: key }),
          request,
        );
        if (typeof response.ContentLength === 'number' && response.ContentLength > maxBytes) {
          throw oversizedObjectError(key, response.ContentLength, maxBytes);
        }
        if (!response.Body) {
          throw new Error(`S3 object body is empty for key: ${truncateForLog(key)}`);
        }
        return readBodyBounded(response.Body, key, maxBytes);
      },
      { maxAttempts: 3, isRetryable: isTransientS3Error, signal },
    );
  } catch (error) {
    rethrowIfCancelled(error as Error);
    throw new DynamoDBLangGraphError(
      redactedMessage(error as Error),
      ErrorCode.S3_OFFLOAD_FAILED,
      { operation: 'download', key },
      error as Error,
    );
  }
}
