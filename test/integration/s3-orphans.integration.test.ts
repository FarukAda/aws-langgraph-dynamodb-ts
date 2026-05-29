/**
 * Integration: cleanUpS3Orphans against REAL LocalStack S3 (REQ-34 / gap F /
 * AC-30).
 *
 * Real S3 — NO aws-sdk-client-mock, NO jest.mock. cleanUpS3Orphans drives a real
 * S3Offloader (built from s3OffloadConfig.clientConfig pointed at LocalStack)
 * and best-effort deletes orphaned objects in a single batch DeleteObjects.
 *
 * Happy path: previously-uploaded orphan objects are actually removed from the
 * bucket (verified via a real ListObjectsV2 count).
 * Error path: cleanup is best-effort — a failure (bucket does not exist) is
 * swallowed (the promise resolves, never re-throws) and leaves real state
 * untouched, so a caller's main flow is never broken by orphan cleanup.
 *
 * Env-gated via RUN_INTEGRATION (REQ-30 / AC-26).
 */
import type { S3Client } from '@aws-sdk/client-s3';

import { S3Offloader } from '../../src/shared/utils/s3-offloader';
import { cleanUpS3Orphans } from '../../src/shared/utils/s3-orphans';
import {
  assertLocalStackReachable,
  countObjects,
  createBucket,
  dropBucket,
  LOCALSTACK_S3_CONFIG,
  makeLocalStackS3Client,
  uniqueBucketName,
} from './helpers/localstack';

const RUN = !!process.env.RUN_INTEGRATION;
const describeIntegration = RUN ? describe : describe.skip;

function makeOffloader(bucketName: string): S3Offloader {
  return new S3Offloader({ bucketName, clientConfig: LOCALSTACK_S3_CONFIG });
}

describeIntegration('integration: cleanUpS3Orphans against LocalStack S3', () => {
  let s3: S3Client;

  beforeAll(async () => {
    s3 = makeLocalStackS3Client();
    await assertLocalStackReachable(s3);
  });

  it('deletes orphaned S3 objects from the bucket in a single best-effort batch', async () => {
    const bucket = uniqueBucketName('orphans-ok');
    await createBucket(s3, bucket);
    const offloader = makeOffloader(bucket);
    try {
      // Upload three real orphan objects, then prove cleanup removes them.
      const keys = ['orphan/a.bin', 'orphan/b.bin', 'orphan/c.bin'];
      await Promise.all(keys.map((k) => offloader.upload(k, new Uint8Array([1, 2, 3]))));
      expect(await countObjects(s3, bucket, 'orphan/')).toBe(keys.length);

      await cleanUpS3Orphans(offloader, keys, 'put-writes');

      // Every orphan is gone from real S3.
      expect(await countObjects(s3, bucket, 'orphan/')).toBe(0);
    } finally {
      if (RUN) await dropBucket(s3, bucket);
    }
  }); // AC-30

  it('filters out undefined/empty keys and removes only the real orphan objects, leaving live objects intact', async () => {
    const bucket = uniqueBucketName('orphans-mixed');
    await createBucket(s3, bucket);
    const offloader = makeOffloader(bucket);
    try {
      await offloader.upload('orphan/x.bin', new Uint8Array([9]));
      await offloader.upload('live/keep.bin', new Uint8Array([7]));

      await cleanUpS3Orphans(offloader, [undefined, 'orphan/x.bin', ''], 'put');

      // The orphan is removed; the unrelated live object survives.
      expect(await countObjects(s3, bucket, 'orphan/')).toBe(0);
      expect(await countObjects(s3, bucket, 'live/')).toBe(1);
    } finally {
      if (RUN) await dropBucket(s3, bucket);
    }
  }); // AC-30

  it('swallows a non-transient delete failure (bucket does not exist) without re-throwing — cleanup is best-effort', async () => {
    // Point at a bucket that was never created. DeleteObjects raises
    // NoSuchBucket; orphan cleanup must absorb it and resolve so the caller's
    // primary operation is never broken by best-effort cleanup.
    const missingBucket = uniqueBucketName('orphans-missing');
    const offloader = makeOffloader(missingBucket);

    const before = await countObjects(s3, missingBucket).catch(() => 0);
    await expect(cleanUpS3Orphans(offloader, ['ghost/key.bin'], 'put')).resolves.toBeUndefined();
    // No bucket was ever created by the failed cleanup; state is unchanged.
    const after = await countObjects(s3, missingBucket).catch(() => 0);
    expect(after).toBe(before);
  }); // AC-30
});
