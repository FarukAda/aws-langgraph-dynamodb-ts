import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

import { downloadObject, uploadObject } from '../../../../../src/shared/codec/s3/read-write';
import { ErrorCode } from '../../../../../src/shared/errors/error-code';

const s3Mock = mockClient(S3Client);

afterEach(() => s3Mock.reset());

describe('uploadObject', () => {
  it('puts the object with content type and SSE', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    await uploadObject(new S3Client({ region: 'us-east-1' }), {
      bucket: 'b',
      key: 'k.bin',
      data: new Uint8Array([1]),
      serverSideEncryption: 'AES256',
    });
    const call = s3Mock.commandCalls(PutObjectCommand)[0];
    expect(call.args[0].input).toMatchObject({
      Bucket: 'b',
      Key: 'k.bin',
      ServerSideEncryption: 'AES256',
      ContentType: 'application/octet-stream',
    });
  });

  it('includes the KMS key id when provided', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    await uploadObject(new S3Client({ region: 'us-east-1' }), {
      bucket: 'b',
      key: 'k.bin',
      data: new Uint8Array([1]),
      serverSideEncryption: 'aws:kms',
      sseKmsKeyId: 'arn:key',
    });
    expect(s3Mock.commandCalls(PutObjectCommand)[0].args[0].input).toMatchObject({
      SSEKMSKeyId: 'arn:key',
    });
  });

  it('wraps a failure as S3_OFFLOAD_FAILED', async () => {
    s3Mock.on(PutObjectCommand).rejects(new Error('boom'));
    try {
      await uploadObject(new S3Client({ region: 'us-east-1' }), {
        bucket: 'b',
        key: 'k',
        data: new Uint8Array(),
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code: ErrorCode }).code).toBe(ErrorCode.S3_OFFLOAD_FAILED);
    }
  });

  it('retries a transient S3 error on upload', async () => {
    s3Mock
      .on(PutObjectCommand)
      .rejectsOnce(Object.assign(new Error('slow down'), { name: 'SlowDown' }))
      .resolves({});
    await uploadObject(new S3Client({ region: 'us-east-1' }), {
      bucket: 'b',
      key: 'k',
      data: new Uint8Array([1]),
    });
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(2);
  });

  it('does not retry a permanent S3 error on upload', async () => {
    s3Mock
      .on(PutObjectCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(
      uploadObject(new S3Client({ region: 'us-east-1' }), {
        bucket: 'b',
        key: 'k',
        data: new Uint8Array([1]),
      }),
    ).rejects.toThrow();
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
  });

  it('wraps retry exhaustion as S3_OFFLOAD_FAILED, not the inner RETRY_EXHAUSTED code', async () => {
    s3Mock
      .on(PutObjectCommand)
      .rejects(Object.assign(new Error('slow down'), { name: 'SlowDown' }));
    await expect(
      uploadObject(new S3Client({ region: 'us-east-1' }), {
        bucket: 'b',
        key: 'k',
        data: new Uint8Array([1]),
      }),
    ).rejects.toMatchObject({
      code: ErrorCode.S3_OFFLOAD_FAILED,
      context: { operation: 'upload', key: 'k' },
    });
  });
});

describe('downloadObject', () => {
  it('returns the body bytes', async () => {
    s3Mock.on(GetObjectCommand).resolves({
      Body: { transformToByteArray: async () => new Uint8Array([7, 8]) } as never,
    });
    expect(await downloadObject(new S3Client({ region: 'us-east-1' }), 'b', 'k.bin')).toEqual(
      new Uint8Array([7, 8]),
    );
  });

  it('throws S3_OFFLOAD_FAILED when the body is empty', async () => {
    s3Mock.on(GetObjectCommand).resolves({});
    await expect(
      downloadObject(new S3Client({ region: 'us-east-1' }), 'b', 'k.bin'),
    ).rejects.toMatchObject({ code: ErrorCode.S3_OFFLOAD_FAILED });
  });
});
