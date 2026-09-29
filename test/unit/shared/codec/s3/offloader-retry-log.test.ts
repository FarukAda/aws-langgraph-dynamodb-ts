import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

import { S3Offloader } from '../../../../../src/shared/codec/s3/offloader';
import { SILENT_LOGGER } from '../../../../../src/shared/logging/logger';

const s3Mock = mockClient(S3Client);
afterEach(() => s3Mock.reset());

const slowDown = () =>
  Object.assign(new Error('slow down'), { name: 'SlowDown', $metadata: { httpStatusCode: 503 } });

function offloaderLoggingTo(debug: jest.Mock): S3Offloader {
  const client = new S3Client({ region: 'us-east-1' });
  return new S3Offloader(
    { bucketName: 'b', createS3Client: () => client },
    { ...SILENT_LOGGER, debug },
  );
}

describe('S3 transfer retries are logged at debug', () => {
  it('logs an upload retry, naming the transfer', async () => {
    s3Mock.on(PutObjectCommand).rejectsOnce(slowDown()).resolves({});
    const debug = jest.fn();
    await offloaderLoggingTo(debug).upload('k.bin', new Uint8Array([1]), { pk: 'p', sk: 's' });
    expect(debug).toHaveBeenCalledWith(
      'retrying after a transient error',
      expect.objectContaining({ attempt: 1, operation: 'upload', error: 'SlowDown' }),
    );
  });

  it('logs a download retry, naming the transfer', async () => {
    s3Mock
      .on(GetObjectCommand)
      .rejectsOnce(slowDown())
      .resolves({
        ContentLength: 1,
        Body: { transformToByteArray: () => Promise.resolve(new Uint8Array([1])) } as never,
      });
    const debug = jest.fn();
    await offloaderLoggingTo(debug).download('k.bin');
    expect(debug).toHaveBeenCalledWith(
      'retrying after a transient error',
      expect.objectContaining({ attempt: 1, operation: 'download' }),
    );
  });
});
