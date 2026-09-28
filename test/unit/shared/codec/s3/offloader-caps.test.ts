import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

import { S3Offloader } from '../../../../../src/shared/codec/s3/offloader';
import { ErrorCode } from '../../../../../src/shared/errors/error-code';

const s3Mock = mockClient(S3Client);
afterEach(() => s3Mock.reset());

const row = { pk: 'STORE#ns', sk: 'k' };

describe('S3Offloader.upload against its own download cap', () => {
  it('refuses a payload no reader configured like this offloader could download, before any request', async () => {
    const client = new S3Client({ region: 'us-east-1' });
    const offloader = new S3Offloader({
      bucketName: 'b',
      maxDownloadBytes: 4,
      createS3Client: () => client,
    });
    await expect(offloader.upload('k.bin', new Uint8Array(5), row)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'payload' },
    });
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('uploads a payload exactly at the cap', async () => {
    const client = new S3Client({ region: 'us-east-1' });
    s3Mock.on(PutObjectCommand).resolves({});
    const offloader = new S3Offloader({
      bucketName: 'b',
      maxDownloadBytes: 4,
      createS3Client: () => client,
    });
    await expect(offloader.upload('k.bin', new Uint8Array(4), row)).resolves.toBe('k.bin');
  });
});

describe('a download refused on its declared length', () => {
  it('releases the body it will not read', async () => {
    const client = new S3Client({ region: 'us-east-1' });
    const destroy = jest.fn();
    const transformToByteArray = jest.fn();
    s3Mock
      .on(GetObjectCommand)
      .resolves({ ContentLength: 10, Body: { destroy, transformToByteArray } as never });
    const offloader = new S3Offloader({
      bucketName: 'b',
      maxDownloadBytes: 4,
      createS3Client: () => client,
    });
    await expect(offloader.download('k.bin')).rejects.toMatchObject({
      code: ErrorCode.S3_OFFLOAD_FAILED,
    });
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(transformToByteArray).not.toHaveBeenCalled();
  });
});
