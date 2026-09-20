import type {
  LifecycleRule,
  S3Client,
  TransitionDefaultMinimumObjectSize,
} from '@aws-sdk/client-s3';

import { S3_RELEASE_GRACE_DAYS } from '../../constants';
import { ValidationError } from '../../errors/errors';
import { loadS3Sdk } from './client';
import { assertScopedKeyPrefix, buildLifecycleRuleId, buildMarkerRuleId } from './config';

/** The bucket's current rules plus the bucket-level field a Put must carry back. */
interface LifecycleState {
  rules: LifecycleRule[];
  transitionDefaultMinimumObjectSize?: TransitionDefaultMinimumObjectSize;
}

async function readState(client: S3Client, bucket: string): Promise<LifecycleState> {
  const { GetBucketLifecycleConfigurationCommand } = await loadS3Sdk();
  try {
    const existing = await client.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
    );
    return {
      rules: existing.Rules ?? [],
      transitionDefaultMinimumObjectSize: existing.TransitionDefaultMinimumObjectSize,
    };
  } catch (error) {
    if ((error as { name?: string }).name === 'NoSuchLifecycleConfiguration') return { rules: [] };
    throw error;
  }
}

/**
 * The fields this package manages on a rule, as one value two rules compare
 * by. Comparing whole rules would issue a write on every call over a field S3
 * reports and this package never sets.
 */
function managedShape(rule: LifecycleRule | undefined): string {
  return JSON.stringify([
    rule?.Status,
    rule?.Filter?.Prefix,
    rule?.Expiration?.Days,
    rule?.Expiration?.ExpiredObjectDeleteMarker,
    rule?.NoncurrentVersionExpiration?.NoncurrentDays,
  ]);
}

/** Whether the rule the bucket carries already says what this call would write. */
function alreadyCorrect(existing: LifecycleRule | undefined, desired: LifecycleRule): boolean {
  return managedShape(existing) === managedShape(desired);
}

/**
 * The noncurrent retention to write: the release grace, or the longer one the
 * bucket already carries. An operator who chose 30 days chose them, and this
 * package needs *at least* the grace rather than any particular value.
 */
function noncurrentDays(existing: LifecycleRule | undefined): number {
  return Math.max(
    existing?.NoncurrentVersionExpiration?.NoncurrentDays ?? 0,
    S3_RELEASE_GRACE_DAYS,
  );
}

/** Expires the current version on the TTL's schedule and released ones on the grace. */
function ttlRule(
  id: string,
  prefix: string,
  days: number,
  existing?: LifecycleRule,
): LifecycleRule {
  return {
    ID: id,
    Filter: { Prefix: prefix },
    Status: 'Enabled',
    Expiration: { Days: days },
    NoncurrentVersionExpiration: { NoncurrentDays: noncurrentDays(existing) },
  };
}

/**
 * Reclaims the delete marker a release leaves once its last noncurrent version
 * has expired. A second rule, not a field on the first: S3 refuses
 * `ExpiredObjectDeleteMarker` inside an `Expiration` that also carries `Days`,
 * so each rule's `Expiration` holds its own half and nothing of the other's.
 */
function markerRule(id: string, prefix: string): LifecycleRule {
  return {
    ID: id,
    Filter: { Prefix: prefix },
    Status: 'Enabled',
    Expiration: { ExpiredObjectDeleteMarker: true },
  };
}

/** `rules` with `rule` replacing the one holding its id, or appended when none does. */
function upsert(rules: readonly LifecycleRule[], rule: LifecycleRule): LifecycleRule[] {
  return rules.some((held) => held.ID === rule.ID)
    ? rules.map((held) => (held.ID === rule.ID ? rule : held))
    : [...rules, rule];
}

/**
 * Refuse to touch a rule that carries this rule's id but scopes a different
 * prefix. The id is a slug of the prefix, and slugging maps every
 * non-alphanumeric character to `-`, so `app/langgraph/` and `app-langgraph/`
 * produce the same id. Taking the rule over would expire one prefix's objects
 * on the other's schedule, and leaving it would silently give this prefix no
 * rule at all.
 */
function assertNoIdCollision(rule: LifecycleRule | undefined, prefix: string, id: string): void {
  const found = rule?.Filter?.Prefix;
  if (rule === undefined || found === undefined || found === prefix) return;
  throw new ValidationError(
    `the S3 lifecycle rule id "${id}" is already used by the prefix "${found}"; two key prefixes ` +
      'that differ only in characters the rule id replaces cannot share one bucket — choose an ' +
      's3.keyPrefix whose letters and digits differ',
    's3.keyPrefix',
  );
}

/**
 * Ensure the two rules scoped to `prefix` exist on `bucket`: a `days`-day
 * expiration for current versions, and the reclaim that removes the delete
 * marker a released payload leaves behind.
 *
 * Accepts: `prefix` — re-checked for scoping here, because these rules are the
 * one place an unscoped prefix would destroy data outside this library's.
 * `days` — the current-version expiry only. Released versions are governed by
 * {@link S3_RELEASE_GRACE_DAYS} instead, which is a floor: a longer noncurrent
 * retention the bucket already carries is kept. Both are inert on an
 * unversioned bucket, which keeps no noncurrent version and leaves no marker.
 *
 * Returns: nothing. Idempotent: when both rules already say this, no write is
 * issued.
 *
 * Throws: ValidationError naming `s3.keyPrefix` for an unscoped prefix, or when
 * either rule id this prefix produces is already held by a different prefix
 * (see {@link assertNoIdCollision}); otherwise whatever the SDK rejects with. A
 * bucket with no lifecycle configuration at all is not an error — S3 reports
 * `NoSuchLifecycleConfiguration` and this starts from an empty rule set.
 *
 * Guarantees: rules this package did not write are preserved, and so is the
 * bucket-level `TransitionDefaultMinimumObjectSize` — a Put replaces the whole
 * configuration, so dropping it would silently reset the bucket to the default.
 */
export async function ensureLifecycleRule(
  client: S3Client,
  bucket: string,
  prefix: string,
  days: number,
): Promise<void> {
  assertScopedKeyPrefix(prefix);
  const ttlId = buildLifecycleRuleId(prefix);
  const markerId = buildMarkerRuleId(prefix);
  const state = await readState(client, bucket);
  const heldTtl = state.rules.find((rule) => rule.ID === ttlId);
  const heldMarker = state.rules.find((rule) => rule.ID === markerId);
  assertNoIdCollision(heldTtl, prefix, ttlId);
  assertNoIdCollision(heldMarker, prefix, markerId);
  const expiry = ttlRule(ttlId, prefix, days, heldTtl);
  const reclaim = markerRule(markerId, prefix);
  if (alreadyCorrect(heldTtl, expiry) && alreadyCorrect(heldMarker, reclaim)) return;
  const merged = upsert(upsert(state.rules, expiry), reclaim);
  const { PutBucketLifecycleConfigurationCommand } = await loadS3Sdk();
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: { Rules: merged },
      ...(state.transitionDefaultMinimumObjectSize === undefined
        ? {}
        : { TransitionDefaultMinimumObjectSize: state.transitionDefaultMinimumObjectSize }),
    }),
  );
}
