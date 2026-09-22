import {
  DeleteTableCommand,
  type DynamoDBClient,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
  type ListObjectVersionsCommandOutput,
  type ObjectIdentifier,
  type S3Client,
  waitUntilBucketNotExists,
} from '@aws-sdk/client-s3';

/**
 * Everything one `ListObjectVersions` page holds, as `DeleteObjects` takes it.
 *
 * Both arrays count, and a bucket still holding either is not empty. A release
 * on a versioned bucket leaves the payload behind as a noncurrent **version**
 * and puts a **delete marker** in front of it, so a sweep that reads only
 * `Versions` leaves every marker, and one that deletes by key alone adds one
 * more. `MaxKeys` bounds the two arrays together, so a page can never exceed
 * the 1000 keys `DeleteObjects` accepts in one request.
 */
function doomedOnPage(page: ListObjectVersionsCommandOutput): ObjectIdentifier[] {
  return [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].flatMap((entry) =>
    entry.Key === undefined ? [] : [{ Key: entry.Key, VersionId: entry.VersionId }],
  );
}

/**
 * Empty and delete a test bucket, page by page, then wait until it is gone. A
 * bucket that was never created (a failed `beforeAll`) is treated as already
 * gone.
 *
 * It lists with `ListObjectVersions` and deletes **by version id**, because the
 * suites that exercise the containment layer need a *versioned* bucket: the
 * sweep this package ships is defined on one. On such a bucket a delete that
 * names only the key does not remove anything — it adds a delete marker — so
 * the `ListObjectsV2` sweep this helper used to do left every noncurrent
 * version and every marker in place, `DeleteBucket` failed with
 * `BucketNotEmpty`, and a failing run left a bucket in the account that nothing
 * would ever remove. Listing versions covers the unversioned case too: there
 * every object is a single version whose id is the literal string `null`, and
 * deleting it by that id removes it outright.
 *
 * The operator running this needs `s3:DeleteObjectVersion` beside
 * `s3:DeleteObject`, and `s3:ListBucketVersions` beside `s3:ListBucket` —
 * neither is an action the library itself ever calls.
 */
export async function deleteBucketCompletely(s3: S3Client, bucket: string): Promise<void> {
  try {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    let truncated = true;
    while (truncated) {
      const page = await s3.send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
        }),
      );
      const objects = doomedOnPage(page);
      if (objects.length > 0) {
        await s3.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects, Quiet: true } }),
        );
      }
      truncated = page.IsTruncated === true;
      keyMarker = page.NextKeyMarker;
      versionIdMarker = page.NextVersionIdMarker;
    }
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
