import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  type LifecycleRule,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

import { ensureLifecycleRule } from '../../../../../src/shared/codec/s3/lifecycle';
import { S3_RELEASE_GRACE_DAYS } from '../../../../../src/shared/constants';

const s3Mock = mockClient(S3Client);

afterEach(() => s3Mock.reset());

const PREFIX = 'langgraph-checkpoints/';
const TTL_ID = 'langgraph-ttl-langgraph-checkpoints';
const TTL_DAYS = 30;

function silent() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

function client(): S3Client {
  return new S3Client({ region: 'us-east-1' });
}

/**
 * A bucket that remembers what was written to it, so a second call reads the
 * first call's result — which is the only way to tell an upgrade that settles
 * from one that rewrites the same rule on every deploy.
 */
function bucketHolding(rules: LifecycleRule[]): { rules: () => LifecycleRule[] } {
  let held = rules;
  s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
  s3Mock.on(GetBucketLifecycleConfigurationCommand).callsFake(() => ({ Rules: held }));
  s3Mock.on(PutBucketLifecycleConfigurationCommand).callsFake((input) => {
    held = input.LifecycleConfiguration?.Rules ?? [];
    return {};
  });
  return { rules: () => held };
}

function writes(): number {
  return s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand).length;
}

/**
 * The rule-set reasoning is unit-tested directly against `rules.ts`; what these
 * cases prove is that the whole set reaches it through the read, and that what
 * comes back settles.
 */
describe('ensureLifecycleRule over a bucket that already holds rules', () => {
  it('writes the retention of a rule it does not own', async () => {
    const bucket = bucketHolding([
      { ID: 'bucket-wide', Status: 'Enabled', NoncurrentVersionExpiration: { NoncurrentDays: 90 } },
    ]);
    await ensureLifecycleRule(client(), 'b', PREFIX, TTL_DAYS, silent());
    const ours = bucket.rules().find((rule) => rule.ID === TTL_ID);
    expect(ours?.NoncurrentVersionExpiration?.NoncurrentDays).toBe(90);
  });

  it('leaves the grace in place when no rule it does not own governs these keys', async () => {
    const bucket = bucketHolding([
      {
        ID: 'unrelated',
        Filter: { Prefix: 'other-app/' },
        Status: 'Enabled',
        NoncurrentVersionExpiration: { NoncurrentDays: 365 },
      },
    ]);
    await ensureLifecycleRule(client(), 'b', PREFIX, TTL_DAYS, silent());
    const ours = bucket.rules().find((rule) => rule.ID === TTL_ID);
    expect(ours?.NoncurrentVersionExpiration?.NoncurrentDays).toBe(S3_RELEASE_GRACE_DAYS);
  });

  /**
   * A rule carrying the older top-level `Prefix` and no `Filter` is upgraded.
   * Sending both back would be refused with `MalformedXML`, failing the
   * provisioning call outright, and re-upgrading it on every deploy would mean
   * the upgrade never took.
   */
  it('upgrades a rule written in the older schema, exactly once', async () => {
    const bucket = bucketHolding([
      { ID: TTL_ID, Prefix: PREFIX, Status: 'Enabled', Expiration: { Days: 7 } },
    ]);
    await ensureLifecycleRule(client(), 'b', PREFIX, TTL_DAYS, silent());
    const upgraded = bucket.rules().find((rule) => rule.ID === TTL_ID);
    expect(upgraded?.Filter).toEqual({ Prefix: PREFIX });
    expect(upgraded === undefined || 'Prefix' in upgraded).toBe(false);
    expect(writes()).toBe(1);

    await ensureLifecycleRule(client(), 'b', PREFIX, TTL_DAYS, silent());
    expect(writes()).toBe(1);
  });

  it('carries a field it does not manage through a ttl change', async () => {
    const bucket = bucketHolding([
      {
        ID: TTL_ID,
        Filter: { Prefix: PREFIX },
        Status: 'Enabled',
        Expiration: { Days: 7 },
        Transitions: [{ Days: 10, StorageClass: 'GLACIER' }],
      },
    ]);
    await ensureLifecycleRule(client(), 'b', PREFIX, TTL_DAYS, silent());
    const ours = bucket.rules().find((rule) => rule.ID === TTL_ID);
    expect(ours?.Transitions).toEqual([{ Days: 10, StorageClass: 'GLACIER' }]);
    expect(ours?.Expiration?.Days).toBe(TTL_DAYS);
  });
});
