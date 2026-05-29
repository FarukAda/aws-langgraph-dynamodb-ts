import type { S3Client } from '@aws-sdk/client-s3';

import { S3_DELETE_BATCH_MAX } from '../../constants';

import { loadS3Sdk } from './client';

/**
 * Delete `keys` from `bucket` in chunks of 1000 (the DeleteObjects limit).
 * Returns the keys S3 reported as failed — never throws on per-key errors so
 * callers (orphan cleanup) can decide how loudly to react.
 */
export async function deleteObjects(
  client: S3Client,
  bucket: string,
  keys: string[],
): Promise<string[]> {
  if (keys.length === 0) return [];
  const { DeleteObjectsCommand } = await loadS3Sdk();
  const failed: string[] = [];
  for (let offset = 0; offset < keys.length; offset += S3_DELETE_BATCH_MAX) {
    const chunk = keys.slice(offset, offset + S3_DELETE_BATCH_MAX);
    const response = await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: chunk.map((key) => ({ Key: key })), Quiet: true },
      }),
    );
    for (const error of response.Errors ?? []) {
      if (error.Key) failed.push(error.Key);
    }
  }
  return failed;
}
