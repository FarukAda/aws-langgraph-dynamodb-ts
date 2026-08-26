import { S3Client } from '@aws-sdk/client-s3';

import { createDefaultS3Client, loadS3Sdk } from '../../../../../src/shared/codec/s3/client';

describe('loadS3Sdk', () => {
  it('loads the SDK module and exposes the command classes (cached on repeat calls)', async () => {
    const first = await loadS3Sdk();
    const second = await loadS3Sdk();
    expect(typeof first.PutObjectCommand).toBe('function');
    expect(second).toBe(first);
  });
});

describe('createDefaultS3Client', () => {
  it('creates a real S3Client from config', async () => {
    const client = await createDefaultS3Client({ region: 'us-east-1' });
    expect(client).toBeInstanceOf(S3Client);
    client.destroy();
  });

  it("defaults to a single SDK attempt (own retry layer owns retries) so it doesn't double the retry budget", async () => {
    const client = await createDefaultS3Client({ region: 'us-east-1' });
    await expect(client.config.maxAttempts()).resolves.toBe(1);
    client.destroy();
  });

  it('honors an explicit maxAttempts override', async () => {
    const client = await createDefaultS3Client({ region: 'us-east-1', maxAttempts: 5 });
    await expect(client.config.maxAttempts()).resolves.toBe(5);
    client.destroy();
  });
});
