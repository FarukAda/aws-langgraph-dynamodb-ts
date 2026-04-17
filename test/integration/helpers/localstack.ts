/**
 * Test harness for LocalStack S3.
 *
 * LocalStack's S3 implementation is API-compatible enough to exercise every
 * path the library uses — PutObject with ServerSideEncryption, GetObject,
 * DeleteObjects (batch), GetBucketLifecycleConfiguration, and
 * PutBucketLifecycleConfiguration. The only LocalStack quirk worth noting is
 * that it accepts anonymous / dummy credentials by default; tests use fake
 * creds to match.
 */

import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';

export const LOCALSTACK_ENDPOINT = process.env.LOCALSTACK_ENDPOINT ?? 'http://localhost:4566';

/**
 * Shared S3 client-config that the library's `s3OffloadConfig.clientConfig`
 * accepts. `forcePathStyle` is required for LocalStack (virtual-host style
 * addressing doesn't resolve against a single-host emulator).
 */
export const LOCALSTACK_S3_CONFIG = {
  endpoint: LOCALSTACK_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  forcePathStyle: true,
};

export function makeLocalStackS3Client(): S3Client {
  return new S3Client(LOCALSTACK_S3_CONFIG);
}

function errorName(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'name' in err) {
    const n = (err as { name: unknown }).name;
    return typeof n === 'string' ? n : undefined;
  }
  return undefined;
}

/**
 * Verify LocalStack S3 is reachable. Gives a human-readable pointer to
 * `docker compose up -d` instead of a raw network timeout.
 */
export async function assertLocalStackReachable(client: S3Client): Promise<void> {
  try {
    await client.send(new ListObjectsV2Command({ Bucket: '__probe__', MaxKeys: 1 }));
  } catch (err) {
    const name = errorName(err);
    // A successful probe returns NoSuchBucket — that's fine, it means S3 is up.
    if (name === 'NoSuchBucket') return;
    // Network-level failures indicate LocalStack isn't running.
    const message =
      err && typeof err === 'object' && 'message' in err
        ? String((err as { message: unknown }).message)
        : String(err);
    if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo/i.test(message)) {
      throw new Error(
        `Could not reach LocalStack S3 at ${LOCALSTACK_ENDPOINT}. ` +
          `Start it with: docker compose up -d. Original error: ${message}`,
        { cause: err },
      );
    }
    // Anything else (auth errors, etc.) surfaces — it means S3 is reachable
    // but misconfigured, which tests need to see anyway.
  }
}

export async function createBucket(client: S3Client, bucketName: string): Promise<void> {
  try {
    await client.send(new CreateBucketCommand({ Bucket: bucketName }));
  } catch (err) {
    // Idempotent: tolerate leaks from prior failed runs.
    const name = errorName(err);
    if (name !== 'BucketAlreadyOwnedByYou' && name !== 'BucketAlreadyExists') {
      throw err;
    }
  }
}

/**
 * Delete every object under the bucket, then delete the bucket itself. Must
 * empty first — S3 rejects DeleteBucket on non-empty buckets.
 */
export async function dropBucket(client: S3Client, bucketName: string): Promise<void> {
  let continuationToken: string | undefined;
  do {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        ContinuationToken: continuationToken,
      }),
    );
    const keys = (list.Contents ?? []).map((c) => ({ Key: c.Key! })).filter((k) => k.Key);
    if (keys.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucketName,
          Delete: { Objects: keys, Quiet: true },
        }),
      );
    }
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);

  try {
    await client.send(new DeleteBucketCommand({ Bucket: bucketName }));
  } catch (err) {
    if (errorName(err) !== 'NoSuchBucket') throw err;
  }
}

/**
 * Count objects under a bucket prefix — useful for asserting offload / cleanup
 * ran the expected number of times.
 */
export async function countObjects(
  client: S3Client,
  bucketName: string,
  prefix?: string,
): Promise<number> {
  let total = 0;
  let continuationToken: string | undefined;
  do {
    const list = await client.send(
      new ListObjectsV2Command({
        Bucket: bucketName,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    total += list.KeyCount ?? 0;
    continuationToken = list.IsTruncated ? list.NextContinuationToken : undefined;
  } while (continuationToken);
  return total;
}

export function uniqueBucketName(label: string): string {
  const rand = Math.random().toString(36).slice(2, 8);
  // S3 bucket names must be lowercase, 3-63 chars, DNS-compliant.
  return `it-${label}-${Date.now()}-${rand}`.toLowerCase();
}
