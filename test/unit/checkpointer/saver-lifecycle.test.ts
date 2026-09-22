import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

import { DynamoDBSaver } from '../../../src/checkpointer/saver';
import { createStrictDocumentMock } from '../../shared/helpers/ddb-mock';

const s3Mock = mockClient(S3Client);
afterEach(() => s3Mock.reset());

const serde = {
  dumpsTyped: async (value: unknown): Promise<[string, Uint8Array]> =>
    await Promise.resolve(['json', new TextEncoder().encode(JSON.stringify(value))]),
  loadsTyped: async (_t: string, d: Uint8Array | string): Promise<unknown> =>
    await Promise.resolve(JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d))),
};

function s3Offload() {
  return { bucketName: 'b', createS3Client: () => new S3Client({ region: 'us-east-1' }) };
}

/**
 * Split out of `saver.test.ts`, which sits at its line cap. Every case here
 * passes a logger and asserts on it: an unstubbed `GetBucketVersioning`
 * resolves as nothing through `aws-sdk-client-mock`, which this package reads
 * as a failed versioning check and warns about — so without that assertion a
 * dropped stub would leave these tests green while proving the opposite of
 * their names.
 */
describe('DynamoDBSaver.ensureS3LifecycleRule', () => {
  it('provisions the rule when both s3 and ttl are configured', async () => {
    const { client } = createStrictDocumentMock();
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [] });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const saver = new DynamoDBSaver({
      tableName: 'ckpt',
      client,
      serde,
      logger,
      s3: s3Offload(),
      ttl: { days: 30 },
    });
    await saver.ensureS3LifecycleRule();
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('reports a bucket that keeps no versions, through the adapter logger', async () => {
    const { client } = createStrictDocumentMock();
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [] });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    s3Mock.on(GetBucketVersioningCommand).resolves({});
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
    const saver = new DynamoDBSaver({
      tableName: 'ckpt',
      client,
      serde,
      logger,
      s3: s3Offload(),
      ttl: { days: 30 },
    });
    await saver.ensureS3LifecycleRule();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('versioning is off'), {
      bucket: 'b',
    });
  });

  it('no-ops when ttl is not configured', async () => {
    const { client } = createStrictDocumentMock();
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde, s3: s3Offload() });
    await expect(saver.ensureS3LifecycleRule()).resolves.toBeUndefined();
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it('no-ops when s3 is not configured', async () => {
    const { client } = createStrictDocumentMock();
    const saver = new DynamoDBSaver({ tableName: 'ckpt', client, serde, ttl: { days: 30 } });
    await expect(saver.ensureS3LifecycleRule()).resolves.toBeUndefined();
    expect(s3Mock.calls()).toHaveLength(0);
  });
});
