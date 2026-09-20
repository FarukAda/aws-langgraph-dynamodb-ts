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

beforeEach(() => {
  s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
  s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
});

function client(): S3Client {
  return new S3Client({ region: 'us-east-1' });
}

/** Run against a bucket holding `rules`, and return the ttl rule that was written. */
async function ttlRuleWrittenOver(
  rules: LifecycleRule[],
  prefix = PREFIX,
  id = TTL_ID,
): Promise<LifecycleRule | undefined> {
  s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: rules });
  await ensureLifecycleRule(client(), 'b', prefix, TTL_DAYS, silent());
  const calls = s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand);
  expect(calls).toHaveLength(1);
  return (calls[0].args[0].input.LifecycleConfiguration?.Rules ?? []).find(
    (rule) => rule.ID === id,
  );
}

/**
 * S3 honours the **shorter** of two overlapping expirations, so a rule this
 * package does not own still decides how long a released payload really
 * survives under its prefix. Reading only this package's own rule let a
 * bucket-wide 90-day retention collapse to the grace the moment a
 * prefix-scoped rule was added beside it.
 */
describe('the noncurrent grace against rules this package does not own', () => {
  it('takes the retention of a bucket-wide rule that has no prefix filter', async () => {
    const written = await ttlRuleWrittenOver([
      { ID: 'bucket-wide', Status: 'Enabled', NoncurrentVersionExpiration: { NoncurrentDays: 90 } },
    ]);
    expect(written?.NoncurrentVersionExpiration?.NoncurrentDays).toBe(90);
  });

  it('takes the retention of a rule whose prefix contains ours', async () => {
    const written = await ttlRuleWrittenOver(
      [
        {
          ID: 'parent-prefix',
          Filter: { Prefix: 'langgraph-checkpoints/' },
          Status: 'Enabled',
          NoncurrentVersionExpiration: { NoncurrentDays: 45 },
        },
      ],
      'langgraph-checkpoints/store/',
      'langgraph-ttl-langgraph-checkpoints-store',
    );
    expect(written?.NoncurrentVersionExpiration?.NoncurrentDays).toBe(45);
  });

  /** A filter this package cannot read in full is read as covering everything. */
  it('treats a rule filtered by tags as covering this prefix', async () => {
    const written = await ttlRuleWrittenOver([
      {
        ID: 'tagged',
        Filter: { And: { Prefix: 'other/', Tags: [{ Key: 'team', Value: 'a' }] } },
        Status: 'Enabled',
        NoncurrentVersionExpiration: { NoncurrentDays: 60 },
      },
    ]);
    expect(written?.NoncurrentVersionExpiration?.NoncurrentDays).toBe(60);
  });

  /** A rule beside ours governs none of our keys and must not raise our grace. */
  it('ignores a rule scoped to a prefix that does not cover ours', async () => {
    const written = await ttlRuleWrittenOver([
      {
        ID: 'unrelated',
        Filter: { Prefix: 'other-app/' },
        Status: 'Enabled',
        NoncurrentVersionExpiration: { NoncurrentDays: 90 },
      },
    ]);
    expect(written?.NoncurrentVersionExpiration?.NoncurrentDays).toBe(S3_RELEASE_GRACE_DAYS);
  });

  /** A rule under ours governs some of our keys, which is not a reason to hold all of them. */
  it('ignores a rule scoped beneath ours', async () => {
    const written = await ttlRuleWrittenOver([
      {
        ID: 'deeper',
        Filter: { Prefix: 'langgraph-checkpoints/store/' },
        Status: 'Enabled',
        NoncurrentVersionExpiration: { NoncurrentDays: 90 },
      },
    ]);
    expect(written?.NoncurrentVersionExpiration?.NoncurrentDays).toBe(S3_RELEASE_GRACE_DAYS);
  });

  it('takes the longest retention when several rules overlap', async () => {
    const written = await ttlRuleWrittenOver([
      { ID: 'bucket-wide', Status: 'Enabled', NoncurrentVersionExpiration: { NoncurrentDays: 7 } },
      {
        ID: 'parent-prefix',
        Filter: { Prefix: 'langgraph-' },
        Status: 'Enabled',
        NoncurrentVersionExpiration: { NoncurrentDays: 120 },
      },
      {
        ID: 'unrelated',
        Filter: { Prefix: 'other-app/' },
        Status: 'Enabled',
        NoncurrentVersionExpiration: { NoncurrentDays: 365 },
      },
    ]);
    expect(written?.NoncurrentVersionExpiration?.NoncurrentDays).toBe(120);
  });
});

/**
 * The rule is rewritten whenever the ttl moves, so anything on it that this
 * package does not manage has to survive that rewrite. It cannot be recovered
 * afterwards: the next call reads the rewritten rule as already correct.
 */
describe('fields on the ttl rule that this package does not manage', () => {
  it('keeps NewerNoncurrentVersions while writing the retention beside it', async () => {
    const written = await ttlRuleWrittenOver([
      {
        ID: TTL_ID,
        Filter: { Prefix: PREFIX },
        Status: 'Enabled',
        Expiration: { Days: 7 },
        NoncurrentVersionExpiration: { NoncurrentDays: 30, NewerNoncurrentVersions: 5 },
      },
    ]);
    expect(written?.NoncurrentVersionExpiration).toEqual({
      NoncurrentDays: 30,
      NewerNoncurrentVersions: 5,
    });
  });

  it('keeps transitions and the multipart abort it never wrote', async () => {
    const written = await ttlRuleWrittenOver([
      {
        ID: TTL_ID,
        Filter: { Prefix: PREFIX },
        Status: 'Enabled',
        Expiration: { Days: 7 },
        Transitions: [{ Days: 10, StorageClass: 'GLACIER' }],
        NoncurrentVersionTransitions: [{ NoncurrentDays: 3, StorageClass: 'GLACIER' }],
        AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
      },
    ]);
    expect(written?.Transitions).toEqual([{ Days: 10, StorageClass: 'GLACIER' }]);
    expect(written?.NoncurrentVersionTransitions).toEqual([
      { NoncurrentDays: 3, StorageClass: 'GLACIER' },
    ]);
    expect(written?.AbortIncompleteMultipartUpload).toEqual({ DaysAfterInitiation: 7 });
    expect(written?.Expiration?.Days).toBe(TTL_DAYS);
  });

  /**
   * The expiration itself is replaced rather than merged: S3 refuses an
   * `Expiration` carrying both `Days` and `Date`, so merging this package's
   * days into a date-based one would produce a rule S3 rejects outright.
   */
  it('replaces a date-based expiration instead of merging days into it', async () => {
    const written = await ttlRuleWrittenOver([
      {
        ID: TTL_ID,
        Filter: { Prefix: PREFIX },
        Status: 'Enabled',
        Expiration: { Date: new Date('2030-01-01T00:00:00.000Z') },
      },
    ]);
    expect(written?.Expiration).toEqual({ Days: TTL_DAYS });
  });
});
