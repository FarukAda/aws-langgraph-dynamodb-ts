import type { LifecycleRule } from '@aws-sdk/client-s3';

import { markerRule, ttlRule } from '../../../../../src/shared/codec/s3/lifecycle';
import { S3_RELEASE_GRACE_DAYS } from '../../../../../src/shared/constants';

const PREFIX = 'langgraph-checkpoints/';
const TTL_ID = 'langgraph-ttl-langgraph-checkpoints';
const MARKER_ID = 'langgraph-ttl-langgraph-checkpoints-markers';
const TTL_DAYS = 30;

const GLACIER = [{ Days: 10, StorageClass: 'GLACIER' as const }];
const ABORT = { DaysAfterInitiation: 7 };

function ttl(existing?: LifecycleRule): LifecycleRule {
  return ttlRule(
    { id: TTL_ID, prefix: PREFIX, days: TTL_DAYS },
    existing === undefined ? [] : [existing],
    existing,
  );
}

/**
 * A rule written before S3 introduced `Filter` carries a top-level `Prefix`
 * instead, and the two are alternatives: a rule holding both is refused with
 * `MalformedXML`, which would fail the provisioning call this package's README
 * tells operators to treat a rejection from as a deployment error. Such a rule
 * is upgraded to a filter, not merged with one.
 */
describe('a rule written in the older schema', () => {
  const legacy = (id: string): LifecycleRule => ({
    ID: id,
    Prefix: 'langgraph-checkpoints/',
    Status: 'Enabled',
    Expiration: { Days: 7 },
  });

  it('is upgraded by the ttl rule rather than carried alongside a filter', () => {
    const written = ttl(legacy(TTL_ID));
    expect(written.Filter).toEqual({ Prefix: PREFIX });
    expect('Prefix' in written).toBe(false);
  });

  it('is upgraded by the marker rule too', () => {
    const written = markerRule(MARKER_ID, PREFIX, legacy(MARKER_ID));
    expect(written.Filter).toEqual({ Prefix: PREFIX });
    expect('Prefix' in written).toBe(false);
  });

  it('still governs these keys while it is being read', () => {
    expect(ttl(legacy(TTL_ID)).NoncurrentVersionExpiration?.NoncurrentDays).toBe(
      S3_RELEASE_GRACE_DAYS,
    );
  });
});

/**
 * Both rules are rewritten whenever either is wrong, so anything on them that
 * this package does not manage has to survive that rewrite. It cannot be
 * recovered afterwards: the next call reads the rewritten rule as correct.
 */
describe('the fields a rewrite carries through', () => {
  it('keeps NewerNoncurrentVersions on the ttl rule, writing the retention beside it', () => {
    const written = ttl({
      ID: TTL_ID,
      Filter: { Prefix: PREFIX },
      Status: 'Enabled',
      Expiration: { Days: 7 },
      NoncurrentVersionExpiration: { NoncurrentDays: 30, NewerNoncurrentVersions: 5 },
    });
    expect(written.NoncurrentVersionExpiration).toEqual({
      NoncurrentDays: 30,
      NewerNoncurrentVersions: 5,
    });
  });

  it('keeps transitions and the multipart abort on the ttl rule', () => {
    const written = ttl({
      ID: TTL_ID,
      Filter: { Prefix: PREFIX },
      Status: 'Enabled',
      Expiration: { Days: 7 },
      Transitions: GLACIER,
      NoncurrentVersionTransitions: [{ NoncurrentDays: 3, StorageClass: 'GLACIER' }],
      AbortIncompleteMultipartUpload: ABORT,
    });
    expect(written.Transitions).toEqual(GLACIER);
    expect(written.NoncurrentVersionTransitions).toEqual([
      { NoncurrentDays: 3, StorageClass: 'GLACIER' },
    ]);
    expect(written.AbortIncompleteMultipartUpload).toEqual(ABORT);
    expect(written.Expiration?.Days).toBe(TTL_DAYS);
  });

  /**
   * The marker rule's filter matches the whole prefix, so a transition on it is
   * an ordinary thing for an operator to add — and the id being one this
   * package invented is no reason to drop what someone else put on it.
   */
  it('keeps transitions and the multipart abort on the marker rule', () => {
    const written = markerRule(MARKER_ID, PREFIX, {
      ID: MARKER_ID,
      Filter: { Prefix: PREFIX },
      Status: 'Enabled',
      Expiration: { ExpiredObjectDeleteMarker: true },
      Transitions: GLACIER,
      AbortIncompleteMultipartUpload: ABORT,
    });
    expect(written.Transitions).toEqual(GLACIER);
    expect(written.AbortIncompleteMultipartUpload).toEqual(ABORT);
  });

  it('keeps a noncurrent retention an operator put on the marker rule', () => {
    const written = markerRule(MARKER_ID, PREFIX, {
      ID: MARKER_ID,
      Filter: { Prefix: PREFIX },
      Status: 'Enabled',
      NoncurrentVersionExpiration: { NoncurrentDays: 45 },
    });
    expect(written.NoncurrentVersionExpiration).toEqual({ NoncurrentDays: 45 });
  });
});

describe('the fields a rewrite sets itself', () => {
  it('gives a fresh ttl rule the canonical shape and nothing else', () => {
    expect(ttl()).toEqual({
      ID: TTL_ID,
      Filter: { Prefix: PREFIX },
      Status: 'Enabled',
      Expiration: { Days: TTL_DAYS },
      NoncurrentVersionExpiration: { NoncurrentDays: S3_RELEASE_GRACE_DAYS },
    });
  });

  it('gives a fresh marker rule an expiration that reclaims markers and nothing else', () => {
    expect(markerRule(MARKER_ID, PREFIX)).toEqual({
      ID: MARKER_ID,
      Filter: { Prefix: PREFIX },
      Status: 'Enabled',
      Expiration: { ExpiredObjectDeleteMarker: true },
    });
  });

  it('re-enables a rule an operator disabled and re-scopes one pointed elsewhere', () => {
    const written = ttl({
      ID: TTL_ID,
      Filter: { Prefix: 'somewhere-else/' },
      Status: 'Disabled',
      Expiration: { Days: 7 },
    });
    expect(written.Status).toBe('Enabled');
    expect(written.Filter).toEqual({ Prefix: PREFIX });
  });

  /**
   * The expiration is replaced rather than merged. Merging this package's
   * `Days` into a `Date` an operator set would change the expiry they
   * configured, whatever the service made of the pair.
   */
  it('replaces a date-based expiration instead of merging days into it', () => {
    const written = ttl({
      ID: TTL_ID,
      Filter: { Prefix: PREFIX },
      Status: 'Enabled',
      Expiration: { Date: new Date('2030-01-01T00:00:00.000Z') },
    });
    expect(written.Expiration).toEqual({ Days: TTL_DAYS });
  });

  it('replaces a days-based expiration on the marker rule with the reclaim', () => {
    const written = markerRule(MARKER_ID, PREFIX, {
      ID: MARKER_ID,
      Filter: { Prefix: PREFIX },
      Status: 'Enabled',
      Expiration: { Days: 5 },
    });
    expect(written.Expiration).toEqual({ ExpiredObjectDeleteMarker: true });
  });
});
