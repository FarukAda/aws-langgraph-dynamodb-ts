import {
  GetBucketVersioningCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

import { DynamoDBSaver } from '../../../src/checkpointer/saver';
import { createStrictDocumentMock } from '../../shared/helpers/ddb-mock';
import { fastLifecyclePoll, lifecycleBucket } from '../../shared/helpers/lifecycle-bucket';

const s3Mock = mockClient(S3Client);
afterEach(() => s3Mock.reset());

const serde = {
  dumpsTyped: (value: unknown): Promise<[string, Uint8Array]> =>
    Promise.resolve(['json', new TextEncoder().encode(JSON.stringify(value))]),
  loadsTyped: (_t: string, d: Uint8Array | string): Promise<unknown> =>
    Promise.resolve(JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d))),
};

function s3Offload() {
  return { bucketName: 'b', createS3Client: () => new S3Client({ region: 'us-east-1' }) };
}

/**
 * The saver's S3 lifecycle provisioning, kept apart from `saver.test.ts`. Every case here
 * passes a logger and asserts on it: an unstubbed `GetBucketVersioning`
 * resolves as nothing through `aws-sdk-client-mock`, which this package reads
 * as a failed versioning check and warns about — so without that assertion a
 * dropped stub would leave these tests green while proving the opposite of
 * their names.
 */
describe('DynamoDBSaver.ensureS3LifecycleRule', () => {
  it('provisions the rule when both s3 and ttl are configured', async () => {
    const { client } = createStrictDocumentMock();
    lifecycleBucket(s3Mock, { Rules: [] });
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
    await fastLifecyclePoll(() => saver.ensureS3LifecycleRule());
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
    // The injected client's own maxAttempts > 1 triggers a fire-and-forget
    // warning from construction (see `warnOnStackedRetries`) that can land at
    // any point relative to this call, not only before it; it is unrelated to
    // lifecycle provisioning, so only a warning this feature itself would
    // raise proves the point this test is named for.
    expect(
      logger.warn.mock.calls.filter(([message]) =>
        typeof message === 'string' ? message.startsWith('ensureS3LifecycleRule') : false,
      ),
    ).toHaveLength(0);
  });

  it('reports a bucket that keeps no versions, through the adapter logger', async () => {
    const { client } = createStrictDocumentMock();
    lifecycleBucket(s3Mock, { Rules: [] });
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
    await fastLifecyclePoll(() => saver.ensureS3LifecycleRule());
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
