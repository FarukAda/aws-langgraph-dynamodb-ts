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
});