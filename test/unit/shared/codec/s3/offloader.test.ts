import {
  DeleteObjectsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

import { S3Offloader } from '../../../../../src/shared/codec/s3/offloader';

const s3Mock = mockClient(S3Client);

afterEach(() => s3Mock.reset());

function makeOffloader(thresholdBytes = 100): { offloader: S3Offloader; client: S3Client } {
  const client = new S3Client({ region: 'us-east-1' });
  const offloader = new S3Offloader({
    bucketName: 'b',
    thresholdBytes,
    createS3Client: () => client,
  });
  return { offloader, client };
}

describe('S3Offloader', () => {
  it('shouldOffload compares against the configured threshold', () => {
    const { offloader } = makeOffloader(100);
    expect(offloader.shouldOffload(new Uint8Array(100))).toBe(true);
    expect(offloader.shouldOffload(new Uint8Array(99))).toBe(false);
  });

  it('buildKey joins parts under the default prefix and getKeyPrefix returns it', () => {
    const { offloader } = makeOffloader();
    expect(offloader.buildKey(['t', 'c', 'checkpoint'])).toBe(
      'langgraph-checkpoints/t/c/checkpoint.bin',
    );
    expect(offloader.getKeyPrefix()).toBe('langgraph-checkpoints/');
  });

  it('upload sends a PutObject and returns the key', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const { offloader } = makeOffloader();
    expect(await offloader.upload('k.bin', new Uint8Array([1]))).toBe('k.bin');
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
  });

  it('download fetches the object bytes', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: { transformToByteArray: async () => new Uint8Array([5]) } as never,
    });
    const { offloader } = makeOffloader();
    expect(await offloader.download('k.bin')).toEqual(new Uint8Array([5]));
  });

  it('deleteBatch deletes the keys and returns failures', async () => {
    s3Mock.on(DeleteObjectsCommand).resolves({});
    const { offloader } = makeOffloader();
    expect(await offloader.deleteBatch(['k1'])).toEqual([]);
  });

  it('reuses the single created client across calls', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const createS3Client = jest.fn(() => new S3Client({ region: 'us-east-1' }));
    const offloader = new S3Offloader({ bucketName: 'b', createS3Client });
    await offloader.upload('a.bin', new Uint8Array([1]));
    await offloader.upload('b.bin', new Uint8Array([1]));
    expect(createS3Client).toHaveBeenCalledTimes(1);
  });

  it('ensureLifecycleRule delegates to the bucket lifecycle config', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [] });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    const { offloader } = makeOffloader();
    await offloader.ensureLifecycleRule(30);
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
  });

  it('builds a default S3 client when no factory seam is given', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const offloader = new S3Offloader({ bucketName: 'b' });
    await offloader.upload('k.bin', new Uint8Array([1]));
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
    offloader.destroy();
  });

  it('destroy releases the client without error even before first use', () => {
    const { offloader } = makeOffloader();
    expect(() => offloader.destroy()).not.toThrow();
  });
});
