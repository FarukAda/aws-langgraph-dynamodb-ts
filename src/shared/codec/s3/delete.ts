import type { S3Client } from '@aws-sdk/client-s3';

import { S3_DELETE_BATCH_MAX } from '../../constants';
import { loadS3Sdk } from './client';

/**
 * Delete `keys` from `bucket`, in chunks of {@link S3_DELETE_BATCH_MAX} — the
 * limit `DeleteObjects` accepts per request.
 *
 * Accepts: `keys` — any length, including empty, which issues no request.
 *
 * Returns: the keys S3 named in an error entry. A per-key failure is reported
 * this way rather than thrown, so the caller (orphan cleanup) decides how
 * loudly to react. An error entry carrying no `Key` cannot be attributed and is
 * not reported.
 *
 * Throws: whatever the SDK rejects with — a request that never reached S3, or
 * one refused whole (permissions, a missing bucket).
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
