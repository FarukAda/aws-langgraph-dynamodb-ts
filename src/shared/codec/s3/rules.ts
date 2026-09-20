import type { LifecycleRule } from '@aws-sdk/client-s3';

import { S3_RELEASE_GRACE_DAYS } from '../../constants';

/**
 * The prefix a rule governs, wherever it names one: in its filter, nested
 * under the filter's `And` beside tags or size bounds, or in the top-level
 * `Prefix` of a rule written before `Filter` existed. `undefined` means the
 * rule names no prefix at all — it is bucket-wide, or filtered only by tags or
 * object size — and a rule like that governs every key here.
 */
function scopeOf(rule: LifecycleRule): string | undefined {
  return rule.Filter?.Prefix ?? rule.Filter?.And?.Prefix ?? rule.Prefix;
}

/**
 * Whether `rule` governs every key under `prefix`.
 *
 * Only an enabled rule does. A disabled one expires nothing, so it cannot
 * shorten anyone's window and must not lengthen this package's either: an
 * operator who disables their own retention rule to hand the job over would
 * otherwise pin this package at that rule's value for good. A rule scoped
 * beside this prefix governs none of its keys and one scoped beneath it only
 * some, so neither of them speaks for all of them.
 */
function governs(rule: LifecycleRule, prefix: string): boolean {
  const scope = scopeOf(rule);
  return rule.Status === 'Enabled' && (scope === undefined || prefix.startsWith(scope));
}

/**
 * The noncurrent retention to write: the longest one already governing these
 * keys, and never less than the release grace.
 *
 * S3 honours the **shorter** of two overlapping expirations, so a rule this
 * package does not own decides how long a released payload really survives
 * under its prefix. Writing the grace beside a bucket-wide 90-day retention
 * would cut that window to a day for every key here, which is the opposite of
 * what a floor is for.
 *
 * The rule this package writes is itself in the set, so the floor ratchets: a
 * value written once outlives the rule that justified it, and the way back
 * down is to delete this package's rule and let it be written afresh.
 */
function noncurrentDays(rules: readonly LifecycleRule[], prefix: string): number {
  const held = rules
    .filter((rule) => governs(rule, prefix))
    .map((rule) => rule.NoncurrentVersionExpiration?.NoncurrentDays ?? 0);
  return Math.max(...held, S3_RELEASE_GRACE_DAYS);
}

/**
 * What a rewrite carries over from the rule it replaces: everything this
 * package does not set itself, less the top-level `Prefix`.
 *
 * That `Prefix` is how a rule written before `Filter` existed names its scope,
 * and the two are alternatives rather than a pair — S3 refuses a rule carrying
 * both, which would fail the provisioning call this package documents as a
 * deployment step. Such a rule is upgraded to a filter, never merged with one.
 */
function carried(existing: LifecycleRule | undefined): Partial<LifecycleRule> {
  const kept: Partial<LifecycleRule> = { ...existing };
  delete kept.Prefix;
  return kept;
}

/**
 * The rule that expires current versions on the TTL's schedule and released
 * ones on the grace.
 *
 * Accepts: `rules` — everything the bucket holds, which is what the grace is
 * measured against. `existing` — the rule this one replaces, if any.
 *
 * Returns: the rule to write. Every field of `existing` this package does not
 * manage is carried through, because the rewrite a changed TTL triggers is
 * otherwise unrecoverable: the next call reads the rewritten rule as already
 * correct and never restores what it dropped.
 *
 * Throws: nothing.
 *
 * Guarantees: the `Expiration` is replaced rather than merged. Merging this
 * package's `Days` into a `Date` an operator set would change the expiry they
 * configured, whatever the service made of the pair.
 */
export function ttlRule(
  id: string,
  prefix: string,
  days: number,
  rules: readonly LifecycleRule[],
  existing?: LifecycleRule,
): LifecycleRule {
  return {
    ...carried(existing),
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
 * The rule that reclaims the delete marker a release leaves, once its last
 * noncurrent version has expired.
 *
 * Accepts: `existing` — the rule this one replaces, if any.
 *
 * Returns: the rule to write, a second one rather than a field on the TTL
 * rule: S3 refuses `ExpiredObjectDeleteMarker` inside an `Expiration` that
 * also carries `Days`, so each rule's `Expiration` holds its own half and
 * nothing of the other's. Fields this package does not manage are carried
 * through as they are on the TTL rule — this id is one this package invented,
 * but that is no reason to drop what an operator has since put on it.
 *
 * Throws: nothing.
 */
export function markerRule(id: string, prefix: string, existing?: LifecycleRule): LifecycleRule {
  return {
    ...carried(existing),
    ID: id,
    Filter: { Prefix: prefix },
    Status: 'Enabled',
    Expiration: { ExpiredObjectDeleteMarker: true },
  };
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

/**
 * Whether the rule the bucket carries already says what would be written.
 *
 * Accepts: `existing` — the held rule, or nothing. `desired` — what a write
 * would put there.
 *
 * Returns: whether a write can be skipped. A rule in the older schema never
 * matches, because it names its prefix somewhere this does not read, so it is
 * rewritten once into a filter and matches from then on.
 *
 * Throws: nothing.
 */
export function alreadyCorrect(
  existing: LifecycleRule | undefined,
  desired: LifecycleRule,
): boolean {
  return managedShape(existing) === managedShape(desired);
}
