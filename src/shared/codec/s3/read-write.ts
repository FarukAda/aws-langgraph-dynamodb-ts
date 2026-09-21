import type { S3Client, ServerSideEncryption } from '@aws-sdk/client-s3';

import { withRetry } from '../../dynamodb/retry';
import { DynamoDBLangGraphError } from '../../errors/base-error';
import { ErrorCode } from '../../errors/error-code';
import { redactedMessage } from '../../logging/secret-patterns';
import { oversizedObjectError, readBodyBounded } from './bounded-body';
import { loadS3Sdk } from './client';
import { isTransientS3Error } from './retry';

/** Parameters for {@link uploadObject}. */
export interface UploadParams {
  bucket: string;
  key: string;
  data: Uint8Array;
  serverSideEncryption?: string;
  sseKmsKeyId?: string;
  /** User metadata stored on the object, used for the DynamoDB backlink. */
  metadata?: Record<string, string>;
}

/**
 * True when S3 refused a conditional write because the key is already taken.
 *
 * With `If-None-Match: *` that is a `412 Precondition Failed` (S3 User Guide,
 * *How to prevent object overwrites with conditional writes*). A key names one
 * write's upload, and only that upload's own requests write it, so the object
 * already there was stored by an earlier attempt of this upload. The upload
 * has nothing left to do, and the 412 is the success case, not a failure.
 */
function alreadyStored(error: Error): boolean {
  const failure = error as Error & { $metadata?: { httpStatusCode?: number } };
  return error.name === 'PreconditionFailed' || failure.$metadata?.httpStatusCode === 412;
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
 * which is the same.
 *
 * Returns: nothing, both when this request stored the object and when S3
 * answered `412` because an earlier attempt of this upload already had. The
 * two are not distinguished because the caller's obligation is identical: the
 * bytes are at that key.
 *
 * Throws: `S3_OFFLOAD_FAILED` carrying the key and the underlying error, after
 * three attempts on a transient failure. Its message quotes the SDK's, with
 * credential shapes redacted — a signing failure names the key it signed with,
 * and this message reaches `err.message` on a public error.
 */
export async function uploadObject(client: S3Client, params: UploadParams): Promise<void> {
  const { PutObjectCommand } = await loadS3Sdk();
  try {
    await withRetry(
      () =>
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
        ),
      { maxAttempts: 3, isRetryable: isTransientS3Error },
    );
  } catch (error) {
    if (alreadyStored(error as Error)) return;
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
 * Accepts: `maxBytes` — the largest object this call will buffer.
 *
 * Returns: the object's bytes.
 *
 * Throws: `S3_OFFLOAD_FAILED` naming the key — for an object over `maxBytes`,
 * for a response with no body, and for any SDK failure that survives the
 * retries. Its message quotes the underlying one with credential shapes
 * redacted; the SDK error is kept as `cause`, so `NoSuchKey` stays
 * distinguishable ({@link isMissingObjectError}).
 *
 * Guarantees: an object over the cap is refused from its declared
 * `ContentLength` before the body is touched, and while streaming when the
 * length is absent, so a replaced or hostile object cannot exhaust memory.
 * Transient failures are retried by this package alone — the client is built
 * with `maxAttempts: 1`.
 */
export async function downloadObject(
  client: S3Client,
  bucket: string,
  key: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const { GetObjectCommand } = await loadS3Sdk();
  try {
    return await withRetry(
      async () => {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (typeof response.ContentLength === 'number' && response.ContentLength > maxBytes) {
          throw oversizedObjectError(key, response.ContentLength, maxBytes);
        }
        if (!response.Body) {
          throw new Error(`S3 object body is empty for key: ${key}`);
        }
        return readBodyBounded(response.Body, key, maxBytes);
      },
      { maxAttempts: 3, isRetryable: isTransientS3Error },
    );
  } catch (error) {
    throw new DynamoDBLangGraphError(
      redactedMessage(error as Error),
      ErrorCode.S3_OFFLOAD_FAILED,
      { operation: 'download', key },
      error as Error,
    );
  }
}
