import { S3Client } from '@aws-sdk/client-s3';

import { createDefaultS3Client, loadS3Sdk } from '../../../../../src/shared/codec/s3/client';
import { ErrorCode } from '../../../../../src/shared/errors/error-code';

type ClientModule = typeof import('../../../../../src/shared/codec/s3/client');

/** Load a fresh copy of the client module whose `@aws-sdk/client-s3` import throws `failure`. */
function isolatedClientModule(failure: Error): ClientModule {
  let loaded: ClientModule | undefined;
  jest.isolateModules(() => {
    jest.doMock('@aws-sdk/client-s3', () => {
      throw failure;
    });
    loaded = jest.requireActual<ClientModule>('../../../../../src/shared/codec/s3/client');
  });
  return loaded!;
}

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

describe('loadS3Sdk without the optional peer (CODEC-05)', () => {
  /** The dynamic import runs after isolateModules returns, so unmock only once the test is done. */
  afterEach(() => jest.dontMock('@aws-sdk/client-s3'));

  it('names the missing peer and the install command in a ValidationError', async () => {
    const missing = Object.assign(new Error("Cannot find package '@aws-sdk/client-s3'"), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const isolated = isolatedClientModule(missing);
    await expect(isolated.loadS3Sdk()).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 's3' },
    });
    await expect(isolated.loadS3Sdk()).rejects.toThrow('npm install @aws-sdk/client-s3');
  });

  it('rethrows a module failure that is not a missing module unchanged', async () => {
    const isolated = isolatedClientModule(new SyntaxError('broken build'));
    await expect(isolated.loadS3Sdk()).rejects.toThrow('broken build');
  });
});
