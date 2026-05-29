/**
 * Strict S3 client mock (aws-sdk-client-mock on S3Client), injected through the
 * new S3 client-factory seam (REQ-47). Models PutObject 5xx, GetObject 404, and
 * DeleteObjects partial-error (REQ-34 / gap F / AC-30).
 */
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient, type AwsClientStub } from 'aws-sdk-client-mock';

export interface StrictS3Mock {
  mock: AwsClientStub<S3Client>;
  /** A factory matching the createS3Client seam signature. */
  createS3Client: () => S3Client;
  reset: () => void;
}

export function createStrictS3Mock(): StrictS3Mock {
  const mock = mockClient(S3Client);
  const install = (): void => {
    mock.reset();
    mock
      .onAnyCommand()
      .rejects(new Error('STRICT_S3_MOCK_UNEXPECTED_COMMAND: un-stubbed S3 command'));
  };
  install();
  return {
    mock,
    // Return a REAL S3Client instance: mockClient(S3Client) patches the prototype
    // `send`, so every instance routes through the strict stub for behavior +
    // commandCalls, while still exposing the genuine lifecycle methods
    // (`destroy()`) that the bare AwsClientStub lacks.
    createS3Client: () => new S3Client({}),
    reset: install,
  };
}

/** PutObject fails with a 5xx server error (mid-write failure). */
export function s3PutObject5xx(mock: AwsClientStub<S3Client>): void {
  const err = Object.assign(new Error('We encountered an internal error. Please try again.'), {
    name: 'InternalError',
    $metadata: { httpStatusCode: 500 },
  });
  mock.on(PutObjectCommand).rejects(err);
}

/** GetObject returns a 404 NoSuchKey (dangling pointer). */
export function s3GetObject404(mock: AwsClientStub<S3Client>): void {
  const err = Object.assign(new Error('The specified key does not exist.'), {
    name: 'NoSuchKey',
    $metadata: { httpStatusCode: 404 },
  });
  mock.on(GetObjectCommand).rejects(err);
}

/** DeleteObjects returns a response with a per-key Errors array. */
export function s3DeleteObjectsWithErrors(
  mock: AwsClientStub<S3Client>,
  errorKeys: string[],
): void {
  mock.on(DeleteObjectsCommand).resolves({
    Deleted: [],
    Errors: errorKeys.map((Key) => ({ Key, Code: 'InternalError', Message: 'failed' })),
  });
}
