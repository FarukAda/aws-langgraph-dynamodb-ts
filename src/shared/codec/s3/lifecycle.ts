import type {
  LifecycleRule,
  S3Client,
  TransitionDefaultMinimumObjectSize,
} from '@aws-sdk/client-s3';

import { S3_RELEASE_GRACE_DAYS } from '../../constants';
import { ValidationError } from '../../errors/errors';
import type { Logger } from '../../logging/logger';
import { loadS3Sdk } from './client';
import { assertScopedKeyPrefix, buildLifecycleRuleId, buildMarkerRuleId } from './config';
import { reportBucketVersioning } from './versioning';

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
 * The noncurrent retention to write: the longest one already governing these
 * keys, and never less than the release grace.
 *
 * S3 honours the **shorter** of two overlapping expirations, so a rule this
 * package does not own decides how long a released payload really survives
 * under its prefix. Writing the grace beside a bucket-wide 90-day retention
 * would cut that window to a day for every key here, which is the opposite of
 * what a floor is for. A rule overlaps when it carries no prefix filter, or
 * one this prefix starts with; a filter this cannot read in full — tags, size
 * bounds — counts as overlapping too, because assuming it covers these keys
 * can only lengthen retention. A rule scoped beside this prefix governs none
 * of its keys, and one scoped beneath it governs only some, so neither raises
 * the floor for all of them.
 */
function noncurrentDays(rules: readonly LifecycleRule[], prefix: string): number {
  const held = rules
    .filter((rule) => {
      const scope = rule.Filter?.Prefix;
      return scope === undefined || prefix.startsWith(scope);
    })
    .map((rule) => rule.NoncurrentVersionExpiration?.NoncurrentDays ?? 0);
  return Math.max(...held, S3_RELEASE_GRACE_DAYS);
}

/**
 * Expires the current version on the TTL's schedule and released ones on the
 * grace, carrying through every field of the rule it replaces that this
 * package does not manage: `NewerNoncurrentVersions`, transitions, the
 * multipart abort. Dropping one is unrecoverable, because the next call reads
 * the rewritten rule as already correct and never restores it. The
 * `Expiration` is the exception and is replaced whole, since S3 refuses one
 * carrying both `Days` and `Date`.
 */
function ttlRule(
  id: string,
  prefix: string,
  days: number,
  rules: readonly LifecycleRule[],
  existing?: LifecycleRule,
): LifecycleRule {
  return {
    ...existing,
    ID: id,
    Filter: { Prefix: prefix },
    Status: 'Enabled',
    Expiration: { Days: days },
    NoncurrentVersionExpiration: {
      ...existing?.NoncurrentVersionExpiration,
      NoncurrentDays: noncurrentDays(rules, prefix),
    },
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
 * Refuse to touch a rule that carries one of this prefix's ids but scopes a
 * different prefix. Two shapes reach here: slugging maps every non-alphanumeric
 * character to `-`, so `app/langgraph/` and `app-langgraph/` produce one id;
 * and the marker rule appends `-markers`, so `app/`'s marker id is the
 * expiration id of `app-markers/`. Taking the rule over would expire one
 * prefix's objects on the other's schedule, and leaving it would silently give
 * this prefix no rule at all.
 */
function assertNoIdCollision(rule: LifecycleRule | undefined, prefix: string, id: string): void {
  const found = rule?.Filter?.Prefix;
  if (rule === undefined || found === undefined || found === prefix) return;
  throw new ValidationError(
    `the S3 lifecycle rule id "${id}" is already used by the prefix "${found}"; an id is the key ` +
      'prefix with every non-alphanumeric character replaced by "-", and the marker rule appends ' +
      '"-markers" to that, so "a/b/" takes the id of "a-b/" and "app/" takes the marker id of ' +
      '"app-markers/" — choose an s3.keyPrefix that produces neither id of any other prefix on ' +
      'this bucket',
    's3.keyPrefix',
  );
}

/** Replace the bucket's whole configuration with `rules`, carrying its own field back. */
async function putRules(
  client: S3Client,
  bucket: string,
  state: LifecycleState,
  rules: LifecycleRule[],
): Promise<void> {
  const { PutBucketLifecycleConfigurationCommand } = await loadS3Sdk();
  await client.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: { Rules: rules },
      ...(state.transitionDefaultMinimumObjectSize === undefined
        ? {}
        : { TransitionDefaultMinimumObjectSize: state.transitionDefaultMinimumObjectSize }),
    }),
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
 * issued. The bucket's versioning state is reported either way, because the
 * containment a released payload depends on is missing or present regardless
 * of whether this particular call had a rule to write.
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
  logger: Logger,
): Promise<void> {
  assertScopedKeyPrefix(prefix);
  const ttlId = buildLifecycleRuleId(prefix);
  const markerId = buildMarkerRuleId(prefix);
  const state = await readState(client, bucket);
  const heldTtl = state.rules.find((rule) => rule.ID === ttlId);
  const heldMarker = state.rules.find((rule) => rule.ID === markerId);
  assertNoIdCollision(heldTtl, prefix, ttlId);
  assertNoIdCollision(heldMarker, prefix, markerId);
  const expiry = ttlRule(ttlId, prefix, days, state.rules, heldTtl);
  const reclaim = markerRule(markerId, prefix);
  if (!alreadyCorrect(heldTtl, expiry) || !alreadyCorrect(heldMarker, reclaim)) {
    await putRules(client, bucket, state, upsert(upsert(state.rules, expiry), reclaim));
  }
  await reportBucketVersioning(client, bucket, logger);
}
