import {
  GetBucketLifecycleConfigurationCommand,
  GetBucketVersioningCommand,
  type LifecycleRule,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

import { buildLifecycleRuleId, buildMarkerRuleId } from '../../../../../src/shared/codec/s3/config';
import { ensureLifecycleRule } from '../../../../../src/shared/codec/s3/lifecycle';
import { S3_RELEASE_GRACE_DAYS } from '../../../../../src/shared/constants';
import { ErrorCode } from '../../../../../src/shared/errors/error-code';

const s3Mock = mockClient(S3Client);

afterEach(() => s3Mock.reset());

const PREFIX = 'langgraph-checkpoints/';
const TTL_ID = 'langgraph-ttl-langgraph-checkpoints';
const MARKER_ID = 'langgraph-ttl-langgraph-checkpoints-markers';
const TTL_DAYS = 30;

/** These cases are not about the report, so the bucket is versioned and silent. */
function silent() {
  return { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
}

beforeEach(() => {
  s3Mock.on(GetBucketVersioningCommand).resolves({ Status: 'Enabled' });
});

function client(): S3Client {
  return new S3Client({ region: 'us-east-1' });
}

/** The rules of the one Put this call issued; fails when it issued none or several. */
function written(): LifecycleRule[] {
  const calls = s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand);
  expect(calls).toHaveLength(1);
  return calls[0].args[0].input.LifecycleConfiguration?.Rules ?? [];
}

function writtenRule(id: string): LifecycleRule | undefined {
  return written().find((rule) => rule.ID === id);
}

/** A correct pair, as a later call reads it back. */
function correctRules(): LifecycleRule[] {
  return [
    {
      ID: TTL_ID,
      Filter: { Prefix: PREFIX },
      Status: 'Enabled',
      Expiration: { Days: TTL_DAYS },
      NoncurrentVersionExpiration: { NoncurrentDays: S3_RELEASE_GRACE_DAYS },
    },
    {
      ID: MARKER_ID,
      Filter: { Prefix: PREFIX },
      Status: 'Enabled',
      Expiration: { ExpiredObjectDeleteMarker: true },
    },
  ];
}

describe('buildMarkerRuleId', () => {
  it('gives the marker rule an id of its own, derived from the same prefix', () => {
    expect(buildMarkerRuleId(PREFIX)).toBe(MARKER_ID);
    expect(buildMarkerRuleId(PREFIX)).not.toBe(buildLifecycleRuleId(PREFIX));
  });
});

describe('the noncurrent-version grace on the ttl rule (CODEC-09)', () => {
  it('keeps a released version for the grace, which is not the ttl', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({});
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', PREFIX, TTL_DAYS, silent());
    const rule = writtenRule(TTL_ID);
    expect(rule?.NoncurrentVersionExpiration?.NoncurrentDays).toBe(S3_RELEASE_GRACE_DAYS);
    expect(rule?.Expiration?.Days).toBe(TTL_DAYS);
  });

  /**
   * An operator who chose 32 days of noncurrent retention chose them. This
   * package needs at least the grace and has no business capping someone
   * else's recovery window, so the value written is the larger of the two.
   */
  it('keeps a longer noncurrent retention the bucket already carries', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: [
        {
          ID: TTL_ID,
          Filter: { Prefix: PREFIX },
          Status: 'Enabled',
          Expiration: { Days: 7 },
          NoncurrentVersionExpiration: { NoncurrentDays: 32 },
        },
      ],
    });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', PREFIX, TTL_DAYS, silent());
    expect(writtenRule(TTL_ID)?.NoncurrentVersionExpiration?.NoncurrentDays).toBe(32);
  });

  /** A rule the grace has never been written onto is rewritten to carry it. */
  it('adds the grace to a rule that expires current versions only', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: [
        {
          ID: TTL_ID,
          Filter: { Prefix: PREFIX },
          Status: 'Enabled',
          Expiration: { Days: TTL_DAYS },
        },
      ],
    });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', PREFIX, TTL_DAYS, silent());
    expect(writtenRule(TTL_ID)?.NoncurrentVersionExpiration?.NoncurrentDays).toBe(
      S3_RELEASE_GRACE_DAYS,
    );
  });

  /** A rule carrying this id but no expiration at all still scopes this prefix. */
  it('rewrites a rule that carries no expiration at all', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: [{ ID: TTL_ID, Filter: { Prefix: PREFIX }, Status: 'Enabled' }],
    });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', PREFIX, TTL_DAYS, silent());
    expect(writtenRule(TTL_ID)?.Expiration?.Days).toBe(TTL_DAYS);
  });
});

describe('the marker-reclaim rule', () => {
  /**
   * Real S3 refuses `ExpiredObjectDeleteMarker` inside an `Expiration` that
   * also carries `Days` with `MalformedXML` 400, so the reclaim is a second
   * rule rather than a field on the first. Each rule's `Expiration` must
   * therefore hold its own half and nothing of the other's.
   */
  it('is a second rule whose expiration reclaims markers and nothing else', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({});
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', PREFIX, TTL_DAYS, silent());
    const marker = writtenRule(MARKER_ID);
    expect(marker?.Expiration).toEqual({ ExpiredObjectDeleteMarker: true });
    expect(marker?.Status).toBe('Enabled');
    expect(marker?.Filter?.Prefix).toBe(PREFIX);
    expect(marker?.NoncurrentVersionExpiration).toBeUndefined();
  });

  it('leaves the ttl rule expiring current versions by days only', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({});
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', PREFIX, TTL_DAYS, silent());
    expect(writtenRule(TTL_ID)?.Expiration).toEqual({ Days: TTL_DAYS });
  });

  it('adds itself beside a ttl rule that is otherwise already correct', async () => {
    s3Mock
      .on(GetBucketLifecycleConfigurationCommand)
      .resolves({ Rules: [correctRules()[0], { ID: 'user-rule', Status: 'Enabled' }] });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', PREFIX, TTL_DAYS, silent());
    expect(written().map((rule) => rule.ID)).toEqual([TTL_ID, 'user-rule', MARKER_ID]);
  });

  it('corrects a rule holding its id that reclaims nothing', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: [
        correctRules()[0],
        { ID: MARKER_ID, Filter: { Prefix: PREFIX }, Status: 'Enabled', Expiration: {} },
      ],
    });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', PREFIX, TTL_DAYS, silent());
    expect(writtenRule(MARKER_ID)?.Expiration).toEqual({ ExpiredObjectDeleteMarker: true });
  });

  it('corrects a rule holding its id that is disabled', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: [
        correctRules()[0],
        {
          ID: MARKER_ID,
          Filter: { Prefix: PREFIX },
          Status: 'Disabled',
          Expiration: { ExpiredObjectDeleteMarker: true },
        },
      ],
    });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', PREFIX, TTL_DAYS, silent());
    expect(writtenRule(MARKER_ID)?.Status).toBe('Enabled');
  });

  /**
   * The marker id can collide in a way the ttl id alone cannot: this prefix's
   * marker id is the ttl id of the prefix `langgraph-checkpoints-markers/`,
   * whose letters and digits already differ from ours. The refusal must name
   * the suffix, or its remedy reads as advice the operator has followed.
   */
  it('refuses when its id is already held by a different prefix', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({
      Rules: [
        {
          ID: MARKER_ID,
          Filter: { Prefix: 'langgraph-checkpoints-markers/' },
          Status: 'Enabled',
          Expiration: { ExpiredObjectDeleteMarker: true },
        },
      ],
    });
    await expect(
      ensureLifecycleRule(client(), 'b', PREFIX, TTL_DAYS, silent()),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 's3.keyPrefix' },
      message: expect.stringContaining('-markers'),
    });
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });
});

describe('a second call over both rules', () => {
  it('issues no write when both rules are already right', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: correctRules() });
    await ensureLifecycleRule(client(), 'b', PREFIX, TTL_DAYS, silent());
    expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
  });

  it('writes when only the ttl rule is right', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [correctRules()[0]] });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', PREFIX, TTL_DAYS, silent());
    expect(written().map((rule) => rule.ID)).toEqual([TTL_ID, MARKER_ID]);
  });

  it('writes when only the marker rule is right', async () => {
    s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [correctRules()[1]] });
    s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
    await ensureLifecycleRule(client(), 'b', PREFIX, TTL_DAYS, silent());
    expect(written().map((rule) => rule.ID)).toEqual([MARKER_ID, TTL_ID]);
  });
});
