import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

import { ensureLifecycleRule } from '../../../../../src/shared/codec/s3/lifecycle';

const s3Mock = mockClient(S3Client);

afterEach(() => s3Mock.reset());

function client(): S3Client {
  return new S3Client({ region: 'us-east-1' });
}

describe('ensureLifecycleRule', () => {
  it('adds the rule when none exists, preserving user rules', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [{ ID: 'user-rule' }] });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', 'langgraph-checkpoints/', 30);
    const put = s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)[0];
    const rules = put.args[0].input.LifecycleConfiguration?.Rules ?? [];
    expect(rules.map((r) => r.ID)).toEqual(['user-rule', 'langgraph-ttl-langgraph-checkpoints']);
    expect(rules[1].Expiration?.Days).toBe(30);
  });

  it('replaces the existing rule in place when the ttl differs', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: [{ ID: 'langgraph-ttl-langgraph-checkpoints', Status: 'Enabled', Expiration: { Days: 7 } }],
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
      Rules: [{ ID: 'langgraph-ttl-langgraph-checkpoints', Status: 'Enabled', Expiration: { Days: 30 } }],
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
    expect(rules.find((r) => r.ID === 'langgraph-ttl-langgraph-checkpoints')?.Expiration?.Days).toBe(
      30,
    );
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
