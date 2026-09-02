import {
  DeleteObjectsCommand,
  GetBucketLifecycleConfigurationCommand,
  GetObjectCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
  S3ClientConfig,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

import * as s3ClientModule from '../../../../../src/shared/codec/s3/client';
import { S3Offloader } from '../../../../../src/shared/codec/s3/offloader';
import { ErrorCode } from '../../../../../src/shared/errors/error-code';
import { ValidationError } from '../../../../../src/shared/errors/errors';

// Wrap (not stub out) the real `createDefaultS3Client` so tests can observe
// call counts / inject failures on the genuine async construction path
// (a real `await import('@aws-sdk/client-s3')` gap) while every other test
// still gets a real, working client via the fall-through to `actual`.
jest.mock('../../../../../src/shared/codec/s3/client', () => {
  const actual = jest.requireActual<typeof import('../../../../../src/shared/codec/s3/client')>(
    '../../../../../src/shared/codec/s3/client',
  );
  return {
    ...actual,
    createDefaultS3Client: jest.fn(actual.createDefaultS3Client),
    loadS3Sdk: jest.fn(actual.loadS3Sdk),
  };
});

const createDefaultS3ClientMock = s3ClientModule.createDefaultS3Client as jest.MockedFunction<
  typeof s3ClientModule.createDefaultS3Client
>;

const loadS3SdkMock = s3ClientModule.loadS3Sdk as jest.MockedFunction<
  typeof s3ClientModule.loadS3Sdk
>;

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

  it('buildKey base64url-encodes parts under the default prefix and getKeyPrefix returns it', () => {
    const { offloader } = makeOffloader();
    const encode = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    expect(offloader.buildKey(['t', 'c', 'checkpoint'])).toBe(
      `langgraph-checkpoints/${encode('t')}/${encode('c')}/${encode('checkpoint')}.bin`,
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

  it('passes maxAttempts: 1 to a custom createS3Client factory too, unless overridden', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const createS3Client = jest.fn((cfg: S3ClientConfig) => new S3Client(cfg));
    const offloader = new S3Offloader({
      bucketName: 'b',
      clientConfig: { region: 'us-east-1' },
      createS3Client,
    });
    await offloader.upload('a.bin', new Uint8Array([1]));
    expect(createS3Client).toHaveBeenCalledWith({ maxAttempts: 1, region: 'us-east-1' });
  });

  it('lets an explicit maxAttempts in clientConfig override the default for a custom factory', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const createS3Client = jest.fn((cfg: S3ClientConfig) => new S3Client(cfg));
    const offloader = new S3Offloader({
      bucketName: 'b',
      clientConfig: { region: 'us-east-1', maxAttempts: 3 },
      createS3Client,
    });
    await offloader.upload('a.bin', new Uint8Array([1]));
    expect(createS3Client).toHaveBeenCalledWith({ region: 'us-east-1', maxAttempts: 3 });
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

  it('destroys a client that finishes constructing after destroy() was called (M2)', async () => {
    // destroy() during the real `await import(...)` gap used to be a no-op:
    // resolvedClient was still undefined, so the client that arrived moments
    // later was never released and leaked for the process's lifetime.
    s3Mock.on(PutObjectCommand).resolves({});
    let resolveClient!: (client: S3Client) => void;
    createDefaultS3ClientMock.mockReturnValueOnce(
      new Promise<S3Client>((resolve) => {
        resolveClient = resolve;
      }),
    );
    const offloader = new S3Offloader({ bucketName: 'b' });
    const pending = offloader.upload('k.bin', new Uint8Array([1]));

    offloader.destroy();

    const client = new S3Client({ region: 'us-east-1' });
    const destroySpy = jest.spyOn(client, 'destroy').mockImplementation(() => undefined);
    resolveClient(client);
    await pending.catch(() => undefined);

    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('createDefaultS3Client is invoked exactly once under concurrent first access on the default async construction path', async () => {
    // Unlike the synchronous `createS3Client` seam, `createDefaultS3Client` has
    // a genuine `await` gap (a real dynamic `import('@aws-sdk/client-s3')`),
    // so this is the path where the historical check-then-act race could
    // actually manifest. Two concurrent first calls must still only
    // construct one client.
    s3Mock.on(PutObjectCommand).resolves({});
    const offloader = new S3Offloader({ bucketName: 'b' });
    await Promise.all([
      offloader.upload('a.bin', new Uint8Array([1])),
      offloader.upload('b.bin', new Uint8Array([1])),
    ]);
    expect(createDefaultS3ClientMock).toHaveBeenCalledTimes(1);
  });

  it('retries client construction after a failed first attempt instead of staying permanently broken', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    const realClient = new S3Client({ region: 'us-east-1' });
    createDefaultS3ClientMock
      .mockRejectedValueOnce(new Error('transient construction failure'))
      .mockResolvedValueOnce(realClient);

    const offloader = new S3Offloader({ bucketName: 'b' });

    await expect(offloader.upload('a.bin', new Uint8Array([1]))).rejects.toThrow(
      'transient construction failure',
    );
    await expect(offloader.upload('b.bin', new Uint8Array([1]))).resolves.toBe('b.bin');

    expect(createDefaultS3ClientMock).toHaveBeenCalledTimes(2);
    offloader.destroy();
  });

  it('does not raise an unhandledRejection when client construction fails', async () => {
    const unhandledReasons: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledReasons.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      createDefaultS3ClientMock.mockRejectedValueOnce(new Error('boom'));
      const offloader = new S3Offloader({ bucketName: 'b' });

      await expect(offloader.upload('a.bin', new Uint8Array([1]))).rejects.toThrow('boom');

      // Let Node's unhandled-rejection detection run; it fires after the
      // microtask queue drains, so a macrotask tick is enough to observe it.
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandledReasons).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

describe('optional peer preload (CODEC-05)', () => {
  it('starts loading @aws-sdk/client-s3 at construction so a missing peer surfaces early', () => {
    loadS3SdkMock.mockClear();
    new S3Offloader({ bucketName: 'b' }).destroy();
    expect(loadS3SdkMock).toHaveBeenCalledTimes(1);
  });

  it('reports a missing peer as the typed error on the first operation, with no unhandledRejection', async () => {
    const unhandledReasons: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandledReasons.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      const missing = new ValidationError('S3 offload requires the optional peer', 's3');
      loadS3SdkMock.mockRejectedValueOnce(missing).mockRejectedValueOnce(missing);
      const { offloader } = makeOffloader();
      await new Promise((resolve) => setImmediate(resolve));
      await expect(offloader.upload('a.bin', new Uint8Array([1]))).rejects.toMatchObject({
        code: ErrorCode.VALIDATION,
        context: { field: 's3' },
      });
      expect(unhandledReasons).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
      loadS3SdkMock.mockReset();
      loadS3SdkMock.mockImplementation(
        jest.requireActual<typeof s3ClientModule>('../../../../../src/shared/codec/s3/client')
          .loadS3Sdk,
      );
    }
  });
});

describe('download cap (CODEC-17)', () => {
  it('passes the configured maxDownloadBytes to every download', async () => {
    const client = new S3Client({ region: 'us-east-1' });
    const offloader = new S3Offloader({
      bucketName: 'b',
      maxDownloadBytes: 4,
      createS3Client: () => client,
    });
    s3Mock.on(GetObjectCommand).resolves({
      ContentLength: 10,
      Body: { transformToByteArray: async () => new Uint8Array(10) } as never,
    });
    await expect(offloader.download('k.bin')).rejects.toMatchObject({
      code: ErrorCode.S3_OFFLOAD_FAILED,
    });
    offloader.destroy();
  });
});

describe('row-sourced key binding (SEC-03)', () => {
  it('ownsKey/assertOwnedKey bind a key to the prefix and the scope parts', () => {
    const { offloader } = makeOffloader();
    const own = offloader.buildKey(['t', 'ns', 'c', 'checkpoint', 'n']);
    expect(offloader.ownsKey(own, ['t'])).toBe(true);
    expect(offloader.ownsKey(own, ['other'])).toBe(false);
    expect(() => offloader.assertOwnedKey(own, ['t'])).not.toThrow();
    expect(() => offloader.assertOwnedKey(own, ['other'])).toThrow(ValidationError);
    offloader.destroy();
  });
});
