/**
 * End-to-end S3Offloader tests against LocalStack.
 *
 * These cover every S3 API call path the library takes, against a real S3
 * implementation — things aws-sdk-client-mock cannot faithfully simulate:
 * actual PutObject header handling for SSE, DeleteObjects batch semantics
 * (>1000-key chunking), GetBucketLifecycleConfiguration on a fresh bucket
 * (NoSuchLifecycleConfiguration path), PutBucketLifecycleConfiguration
 * merge-in-place semantics.
 */

import {
  GetBucketLifecycleConfigurationCommand,
  GetObjectAttributesCommand,
  HeadObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import { S3Offloader } from '../../src/shared';
import {
  assertLocalStackReachable,
  countObjects,
  createBucket,
  dropBucket,
  LOCALSTACK_S3_CONFIG,
  makeLocalStackS3Client,
  uniqueBucketName,
} from './helpers/localstack';

const bucketName = uniqueBucketName('s3offloader');
let probeClient: S3Client;
let offloader: S3Offloader;

beforeAll(async () => {
  probeClient = makeLocalStackS3Client();
  await assertLocalStackReachable(probeClient);
  await createBucket(probeClient, bucketName);

  offloader = new S3Offloader({
    bucketName,
    keyPrefix: 'langgraph-test/',
    thresholdBytes: 1024,
    clientConfig: LOCALSTACK_S3_CONFIG,
  });
});

afterAll(async () => {
  offloader.destroy();
  await dropBucket(probeClient, bucketName);
  probeClient.destroy();
});

describe('S3Offloader against LocalStack', () => {
  it('shouldOffload respects the configured threshold', () => {
    expect(offloader.shouldOffload(new Uint8Array(1023))).toBe(false);
    expect(offloader.shouldOffload(new Uint8Array(1024))).toBe(true);
  });

  it('builds S3 keys under the configured prefix', () => {
    const key = offloader.buildKey('thread-x', 'ckpt-y', 'checkpoint');
    expect(key).toBe('langgraph-test/thread-x/ckpt-y/checkpoint.bin');
  });

  it('upload → download round-trips a real object byte-for-byte', async () => {
    const payload = new Uint8Array(4096);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 7 + 3) % 256;
    const key = offloader.buildKey('t1', 'c1', 'checkpoint');

    await offloader.upload(key, payload);
    const retrieved = await offloader.download(key);

    expect(retrieved.length).toBe(payload.length);
    expect(Buffer.from(retrieved).equals(Buffer.from(payload))).toBe(true);
  });

  it('upload stamps ServerSideEncryption: AES256 on the object by default', async () => {
    const key = offloader.buildKey('t1', 'c-sse', 'checkpoint');
    await offloader.upload(key, new Uint8Array([1, 2, 3]));

    // LocalStack faithfully echoes the SSE header back in HeadObject's response.
    const head = await probeClient.send(new HeadObjectCommand({ Bucket: bucketName, Key: key }));
    expect(head.ServerSideEncryption).toBe('AES256');
  });

  it('delete removes a single object', async () => {
    const key = offloader.buildKey('t-del', 'c1', 'checkpoint');
    await offloader.upload(key, new Uint8Array([1, 2, 3]));

    await offloader.delete(key);

    await expect(
      probeClient.send(
        new GetObjectAttributesCommand({
          Bucket: bucketName,
          Key: key,
          ObjectAttributes: ['ObjectSize'],
        }),
      ),
    ).rejects.toMatchObject({ name: 'NoSuchKey' });
  });

  it('deleteBatch handles more than 1000 objects by chunking', async () => {
    const keys: string[] = [];
    // 1200 objects forces two chunks (S3 DeleteObjects is capped at 1000).
    for (let i = 0; i < 1200; i++) {
      const k = offloader.buildKey('t-batch', 'c', `idx-${i}`);
      await offloader.upload(k, new Uint8Array([i & 0xff]));
      keys.push(k);
    }

    await offloader.deleteBatch(keys);

    const remaining = await countObjects(probeClient, bucketName, 'langgraph-test/t-batch/');
    expect(remaining).toBe(0);
  }, 180_000);

  it('deleteBatch is a no-op on empty input', async () => {
    await expect(offloader.deleteBatch([])).resolves.toBeUndefined();
  });

  it('download throws a clear error for missing keys', async () => {
    await expect(offloader.download('langgraph-test/does-not-exist.bin')).rejects.toMatchObject({
      name: 'NoSuchKey',
    });
  });

  describe('ensureLifecycleRule', () => {
    it('creates a new lifecycle rule when none exists', async () => {
      // Fresh bucket so there's no lifecycle config yet — exercises the
      // NoSuchLifecycleConfiguration catch branch.
      const freshBucket = uniqueBucketName('lifecycle-create');
      await createBucket(probeClient, freshBucket);
      try {
        const o = new S3Offloader({
          bucketName: freshBucket,
          keyPrefix: 'langgraph-fresh/',
          clientConfig: LOCALSTACK_S3_CONFIG,
        });
        try {
          await o.ensureLifecycleRule(30);
          const cfg = await probeClient.send(
            new GetBucketLifecycleConfigurationCommand({ Bucket: freshBucket }),
          );
          const rule = cfg.Rules?.find((r) => r.ID === 'langgraph-ttl-langgraph-fresh');
          expect(rule).toBeDefined();
          expect(rule?.Status).toBe('Enabled');
          expect(rule?.Expiration?.Days).toBe(30);
          expect((rule?.Filter as { Prefix?: string } | undefined)?.Prefix).toBe(
            'langgraph-fresh/',
          );
        } finally {
          o.destroy();
        }
      } finally {
        await dropBucket(probeClient, freshBucket);
      }
    });

    it('updates an existing rule in-place when ttlDays changes', async () => {
      const b = uniqueBucketName('lifecycle-update');
      await createBucket(probeClient, b);
      try {
        const o = new S3Offloader({
          bucketName: b,
          keyPrefix: 'langgraph-upd/',
          clientConfig: LOCALSTACK_S3_CONFIG,
        });
        try {
          await o.ensureLifecycleRule(30);
          await o.ensureLifecycleRule(90);
          const cfg = await probeClient.send(
            new GetBucketLifecycleConfigurationCommand({ Bucket: b }),
          );
          // Must be updated in place, not duplicated.
          const ours = (cfg.Rules ?? []).filter((r) => r.ID === 'langgraph-ttl-langgraph-upd');
          expect(ours).toHaveLength(1);
          expect(ours[0].Expiration?.Days).toBe(90);
        } finally {
          o.destroy();
        }
      } finally {
        await dropBucket(probeClient, b);
      }
    });

    it('is idempotent when called repeatedly with the same ttlDays', async () => {
      const b = uniqueBucketName('lifecycle-idem');
      await createBucket(probeClient, b);
      try {
        const o = new S3Offloader({
          bucketName: b,
          keyPrefix: 'langgraph-idem/',
          clientConfig: LOCALSTACK_S3_CONFIG,
        });
        try {
          await o.ensureLifecycleRule(30);
          await o.ensureLifecycleRule(30);
          await o.ensureLifecycleRule(30);
          const cfg = await probeClient.send(
            new GetBucketLifecycleConfigurationCommand({ Bucket: b }),
          );
          const ours = (cfg.Rules ?? []).filter((r) => r.ID === 'langgraph-ttl-langgraph-idem');
          expect(ours).toHaveLength(1);
          expect(ours[0].Expiration?.Days).toBe(30);
        } finally {
          o.destroy();
        }
      } finally {
        await dropBucket(probeClient, b);
      }
    });

    it('preserves unrelated pre-existing lifecycle rules', async () => {
      const b = uniqueBucketName('lifecycle-coexist');
      await createBucket(probeClient, b);
      try {
        // Plant a user rule the library has nothing to do with.
        const { PutBucketLifecycleConfigurationCommand } = await import('@aws-sdk/client-s3');
        await probeClient.send(
          new PutBucketLifecycleConfigurationCommand({
            Bucket: b,
            LifecycleConfiguration: {
              Rules: [
                {
                  ID: 'user-archive-rule',
                  Status: 'Enabled',
                  Filter: { Prefix: 'archive/' },
                  Expiration: { Days: 365 },
                },
              ],
            },
          }),
        );

        const o = new S3Offloader({
          bucketName: b,
          keyPrefix: 'langgraph-coexist/',
          clientConfig: LOCALSTACK_S3_CONFIG,
        });
        try {
          await o.ensureLifecycleRule(30);
          const cfg = await probeClient.send(
            new GetBucketLifecycleConfigurationCommand({ Bucket: b }),
          );
          const ids = (cfg.Rules ?? []).map((r) => r.ID).sort();
          expect(ids).toEqual(['langgraph-ttl-langgraph-coexist', 'user-archive-rule']);
        } finally {
          o.destroy();
        }
      } finally {
        await dropBucket(probeClient, b);
      }
    });
  });
});
