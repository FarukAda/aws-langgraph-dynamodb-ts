import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

import { ensureLifecycleRule } from '../../../../../src/shared/codec/s3/lifecycle';
import { ErrorCode } from '../../../../../src/shared/errors/error-code';

const s3Mock = mockClient(S3Client);

afterEach(() => s3Mock.reset());

function client(): S3Client {
  return new S3Client({ region: 'us-east-1' });
}

describe('ensureLifecycleRule', () => {
  it('adds the rule when none exists, preserving user rules', async () => {
    s3Mock
      .on(GetBucketLifecycleConfigurationCommand)
      .resolves({ Rules: [{ ID: 'user-rule', Status: 'Enabled' }] });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', 'langgraph-checkpoints/', 30);
    const put = s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)[0];
    const rules = put.args[0].input.LifecycleConfiguration?.Rules ?? [];
    expect(rules.map((r) => r.ID)).toEqual([
      'user-rule',
      'langgraph-ttl-langgraph-checkpoints',
      'langgraph-ttl-langgraph-checkpoints-markers',
    ]);
    expect(rules[1].Expiration?.Days).toBe(30);
  });

  it('replaces the existing rule in place when the ttl differs', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: [
        { ID: 'langgraph-ttl-langgraph-checkpoints', Status: 'Enabled', Expiration: { Days: 7 } },
      ],
    });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', 'langgraph-checkpoints/', 30);
    const rules =
      s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)[0].args[0].input
        .LifecycleConfiguration?.Rules ?? [];
    expect(rules).toHaveLength(2);
    expect(rules[0].ID).toBe('langgraph-ttl-langgraph-checkpoints');
    expect(rules[0].Expiration?.Days).toBe(30);
  });

  it('is a no-op when both rules already scope this prefix with the right ttl', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: [
        {
          ID: 'langgraph-ttl-langgraph-checkpoints',
          Filter: { Prefix: 'langgraph-checkpoints/' },
          Status: 'Enabled',
          Expiration: { Days: 30 },
          NoncurrentVersionExpiration: { NoncurrentDays: 30 },
        },
        {
          ID: 'langgraph-ttl-langgraph-checkpoints-markers',
          Filter: { Prefix: 'langgraph-checkpoints/' },
          Status: 'Enabled',
          Expiration: { ExpiredObjectDeleteMarker: true },
        },
      ],
    });
    await ensureLifecycleRule(client(), 'b', 'langgraph-checkpoints/', 30);
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  /** A rule carrying this id but no filter scopes nothing knowable; it is rewritten. */
  it('rewrites a rule that has the right ttl but carries no prefix filter', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: [
        {
          ID: 'langgraph-ttl-langgraph-checkpoints',
          Status: 'Enabled',
          Expiration: { Days: 30 },
          NoncurrentVersionExpiration: { NoncurrentDays: 30 },
        },
      ],
    });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', 'langgraph-checkpoints/', 30);
    const rules =
      s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)[0].args[0].input
        .LifecycleConfiguration?.Rules ?? [];
    expect(rules[0].Filter?.Prefix).toBe('langgraph-checkpoints/');
  });

  /**
   * The rule id is a slug of the prefix, and slugging maps every
   * non-alphanumeric character to `-`, so `a/b/` and `a-b/` produce one id.
   * Taking the rule over would expire one prefix's objects on the other's
   * schedule; leaving it would give this prefix no rule at all.
   */
  it('refuses when the id it would use is already held by a different prefix', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: [
        {
          ID: 'langgraph-ttl-a-b',
          Filter: { Prefix: 'a/b/' },
          Status: 'Enabled',
          Expiration: { Days: 30 },
          NoncurrentVersionExpiration: { NoncurrentDays: 30 },
        },
      ],
    });
    await expect(ensureLifecycleRule(client(), 'b', 'a-b/', 30)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 's3.keyPrefix' },
    });
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('treats a response with no Rules field as an empty rule set', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({});
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', 'langgraph-checkpoints/', 14);
    const rules =
      s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)[0].args[0].input
        .LifecycleConfiguration?.Rules ?? [];
    expect(rules.map((r) => r.ID)).toEqual([
      'langgraph-ttl-langgraph-checkpoints',
      'langgraph-ttl-langgraph-checkpoints-markers',
    ]);
  });

  it('keeps other user rules untouched when replacing our rule', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: [
        { ID: 'user-rule', Status: 'Enabled', Expiration: { Days: 99 } },
        { ID: 'langgraph-ttl-langgraph-checkpoints', Status: 'Enabled', Expiration: { Days: 7 } },
      ],
    });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', 'langgraph-checkpoints/', 30);
    const rules =
      s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)[0].args[0].input
        .LifecycleConfiguration?.Rules ?? [];
    expect(rules.find((r) => r.ID === 'user-rule')?.Expiration?.Days).toBe(99);
    expect(
      rules.find((r) => r.ID === 'langgraph-ttl-langgraph-checkpoints')?.Expiration?.Days,
    ).toBe(30);
  });

  it('treats NoSuchLifecycleConfiguration as an empty rule set', async () => {
    s3Mock
      .on(GetBucketLifecycleConfigurationCommand)
      .rejects(Object.assign(new Error('none'), { name: 'NoSuchLifecycleConfiguration' }));
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', 'langgraph-checkpoints/', 7);
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
  });

  it('rethrows non-NoSuchLifecycleConfiguration read errors', async () => {
    s3Mock
      .on(GetBucketLifecycleConfigurationCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(ensureLifecycleRule(client(), 'b', 'langgraph-checkpoints/', 7)).rejects.toThrow(
      'denied',
    );
  });
});

describe('ensureLifecycleRule prefix guard (SEC-04, CODEC-07)', () => {
  it.each(['', '/', 'app'])('refuses prefix %j before touching S3', async (prefix) => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({});
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await expect(ensureLifecycleRule(client(), 'b', prefix, 7)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 's3.keyPrefix' },
    });
    expect(s3Mock.calls()).toHaveLength(0);
  });
});

describe('ensureLifecycleRule rule shape (CODEC-12)', () => {
  it('forwards TransitionDefaultMinimumObjectSize instead of resetting it', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: [],
      TransitionDefaultMinimumObjectSize: 'varies_by_storage_class',
    });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', 'langgraph-checkpoints/', 30);
    expect(
      s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)[0].args[0].input
        .TransitionDefaultMinimumObjectSize,
    ).toBe('varies_by_storage_class');
  });

  it('omits TransitionDefaultMinimumObjectSize when the bucket had none', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({});
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', 'langgraph-checkpoints/', 30);
    expect(
      'TransitionDefaultMinimumObjectSize' in
        s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)[0].args[0].input,
    ).toBe(false);
  });
});
