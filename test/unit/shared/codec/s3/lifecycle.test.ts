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
    expect(rules.map((r) => r.ID)).toEqual(['user-rule', 'langgraph-ttl-langgraph-checkpoints']);
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
    expect(rules).toHaveLength(1);
    expect(rules[0].Expiration?.Days).toBe(30);
  });

  it('is a no-op when the matching rule already has the right ttl', async () => {
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
    await ensureLifecycleRule(client(), 'b', 'langgraph-checkpoints/', 30);
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('treats a response with no Rules field as an empty rule set', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({});
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', 'langgraph-checkpoints/', 14);
    const rules =
      s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)[0].args[0].input
        .LifecycleConfiguration?.Rules ?? [];
    expect(rules.map((r) => r.ID)).toEqual(['langgraph-ttl-langgraph-checkpoints']);
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

describe('ensureLifecycleRule rule shape (CODEC-09, CODEC-12)', () => {
  it('expires noncurrent versions after the same number of days as current ones', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({});
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', 'langgraph-checkpoints/', 30);
    const rule = s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)[0].args[0].input
      .LifecycleConfiguration?.Rules?.[0];
    expect(rule?.Expiration?.Days).toBe(30);
    expect(rule?.NoncurrentVersionExpiration?.NoncurrentDays).toBe(30);
  });

  it('rewrites an existing rule that has the right Days but no noncurrent-version expiration', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: [
        { ID: 'langgraph-ttl-langgraph-checkpoints', Status: 'Enabled', Expiration: { Days: 30 } },
      ],
    });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', 'langgraph-checkpoints/', 30);
    const rules =
      s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)[0].args[0].input
        .LifecycleConfiguration?.Rules ?? [];
    expect(rules).toHaveLength(1);
    expect(rules[0].NoncurrentVersionExpiration?.NoncurrentDays).toBe(30);
  });

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
