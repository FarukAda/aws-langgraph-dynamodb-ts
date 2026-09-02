import {
  DeleteTableCommand,
  type DynamoDBClient,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  type S3Client,
  waitUntilBucketNotExists,
} from '@aws-sdk/client-s3';

/**
 * Empty and delete a test bucket, page by page, then wait until it is gone. A
 * bucket that was never created (a failed `beforeAll`) is treated as already
 * gone. Test buckets are unversioned, so plain object listing is exhaustive;
 * a versioned bucket would additionally need its versions and delete markers
 * removed.
 */
export async function deleteBucketCompletely(s3: S3Client, bucket: string): Promise<void> {
  let token: string | undefined;
  try {
    do {
      const page = await s3.send(
        new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
      );
      const objects = (page.Contents ?? []).flatMap((object) =>
        object.Key === undefined ? [] : [{ Key: object.Key }],
      );
      if (objects.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
        );
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token !== undefined);
  } catch (error) {
    if ((error as { name?: string }).name === 'NoSuchBucket') return;
    throw error;
  }
  await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
  await waitUntilBucketNotExists({ client: s3, maxWaitTime: 90 }, { Bucket: bucket });
}

/** Delete a test table and wait until it is gone. */
export async function deleteTableCompletely(
  admin: DynamoDBClient,
  tableName: string,
): Promise<void> {
  await admin.send(new DeleteTableCommand({ TableName: tableName }));
  await waitUntilTableNotExists({ client: admin, maxWaitTime: 90 }, { TableName: tableName });
}

/**
 * Run every teardown step, even when an earlier one fails, and only then
 * rethrow the first failure: one broken resource must never orphan the others
 * (an unreachable bucket used to leave the table behind, run after run).
 */
export async function settleAll(steps: readonly (() => Promise<void> | void)[]): Promise<void> {
  const results = await Promise.allSettled(steps.map(async (step) => step()));
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected',
  );
  if (failure) throw failure.reason;
}
