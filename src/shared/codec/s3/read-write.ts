import type { S3Client, ServerSideEncryption } from '@aws-sdk/client-s3';

import { withRetry } from '../../dynamodb/retry';
import { DynamoDBLangGraphError } from '../../errors/base-error';
import { ErrorCode } from '../../errors/error-code';
import { loadS3Sdk } from './client';
import { RETRYABLE_S3_SIGNALS } from './retry';

/** Parameters for {@link uploadObject}. */
export interface UploadParams {
  bucket: string;
  key: string;
  data: Uint8Array;
  serverSideEncryption?: string;
  sseKmsKeyId?: string;
}

/** Upload `data` to S3, wrapping failures as `S3_OFFLOAD_FAILED`. */
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
            ServerSideEncryption: params.serverSideEncryption as ServerSideEncryption | undefined,
            ...(params.sseKmsKeyId ? { SSEKMSKeyId: params.sseKmsKeyId } : {}),
          }),
        ),
      { maxAttempts: 3, retryableErrors: RETRYABLE_S3_SIGNALS },
    );
  } catch (error) {
    throw new DynamoDBLangGraphError(
      (error as Error).message,
      ErrorCode.S3_OFFLOAD_FAILED,
      { operation: 'upload', key: params.key },
      error as Error,
    );
  }
}

/** Download an object's bytes, wrapping failures/empty bodies as `S3_OFFLOAD_FAILED`. */
export async function downloadObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<Uint8Array> {
  const { GetObjectCommand } = await loadS3Sdk();
  try {
    return await withRetry(
      async () => {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!response.Body) {
          throw new Error(`S3 object body is empty for key: ${key}`);
        }
        return new Uint8Array(await response.Body.transformToByteArray());
      },
      { maxAttempts: 3, retryableErrors: RETRYABLE_S3_SIGNALS },
    );
  } catch (error) {
    throw new DynamoDBLangGraphError(
      (error as Error).message,
      ErrorCode.S3_OFFLOAD_FAILED,
      { operation: 'download', key },
      error as Error,
    );
  }
}
