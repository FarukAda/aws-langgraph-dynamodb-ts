/**
 * Hides the bucket lifecycle configuration this package maintains.
 *
 * Two rules per prefix — one expiring objects a day after the ttl plus the
 * sweep margin and keeping a released payload's noncurrent version for a grace
 * window, one reclaiming expired delete markers — are written without
 * disturbing any other rule on the bucket, rewritten only when they differ,
 * and followed by a report of whether the bucket keeps versions at all.
 */

import type {
  LifecycleRule,
  S3Client,
  TransitionDefaultMinimumObjectSize,
} from '@aws-sdk/client-s3';

import { S3_RELEASE_GRACE_DAYS } from '../../constants';
import { isMissingLifecycleConfiguration } from '../../errors/classify';
import { validationError } from '../../errors/errors';
import type { Logger } from '../../logging/logger';
import { truncateForLog } from '../../logging/truncate';
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
    if (isMissingLifecycleConfiguration(error as Error)) return { rules: [] };
    throw error;
  }
}

/** `rules` with `rule` replacing the one holding its id, or appended when none does. */
function upsert(rules: readonly LifecycleRule[], rule: LifecycleRule): LifecycleRule[] {
  return rules.some((held) => held.ID === rule.ID)
    ? rules.map((held) => (held.ID === rule.ID ? rule : held))
    : [...rules, rule];
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

/** The rules to ensure: on which bucket, for which prefix, expiring after how many days. */
export interface LifecycleTarget {
  readonly bucket: string;
  readonly prefix: string;
  readonly days: number;
}

/**
 * Ensure the two rules scoped to `target.prefix` exist on `target.bucket`: a
 * `target.days`-day expiration for current versions, and the reclaim that
 * removes the delete marker a released payload leaves behind.
 *
 * Accepts: `target.prefix` — re-checked for scoping here, because these rules
 * are the one place an unscoped prefix would destroy data outside this
 * library's. `target.days` — the current-version expiry only. Released
 * versions are governed by the release grace instead (see {@link ttlRule}),
 * which is a floor measured against every rule already governing these keys.
 * Both are inert on an unversioned bucket, which keeps no noncurrent version
 * and leaves no marker.
 *
 * Returns: nothing. Idempotent: when both rules already say this, no write is
 * issued. The bucket's versioning state is reported either way, because the
 * containment a released payload depends on is missing or present regardless
 * of whether this particular call had a rule to write.
 *
 * Throws: `VALIDATION` naming `s3.keyPrefix` for an unscoped prefix, or when
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
  target: LifecycleTarget,
  logger: Logger,
): Promise<void> {
  assertScopedKeyPrefix(target.prefix);
  const ttlId = buildLifecycleRuleId(target.prefix);
  const markerId = buildMarkerRuleId(target.prefix);
  const state = await readState(client, target.bucket);
  const heldTtl = state.rules.find((rule) => rule.ID === ttlId);
  const heldMarker = state.rules.find((rule) => rule.ID === markerId);
  assertNoIdCollision(heldTtl, target.prefix, ttlId);
  assertNoIdCollision(heldMarker, target.prefix, markerId);
  const expiry = ttlRule(
    { id: ttlId, prefix: target.prefix, days: target.days },
    state.rules,
    heldTtl,
  );
  const reclaim = markerRule(markerId, target.prefix, heldMarker);
  if (!alreadyCorrect(heldTtl, expiry) || !alreadyCorrect(heldMarker, reclaim)) {
    await putRules(client, target.bucket, state, upsert(upsert(state.rules, expiry), reclaim));
  }
  await reportBucketVersioning(client, target.bucket, logger);
}

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
 * The rule being replaced counts whatever its status, unlike every other rule
 * here: that value is this package's own committed floor rather than a
 * constraint someone else placed on these keys, and `Status` has nothing to say
 * about it. An operator who disables the rule to pause expiry during an
 * incident would otherwise find the recovery window cut to the grace on the
 * next deploy — a second way down from the ratchet, and a silent one.
 *
 * The rule this package writes is itself in the set, so the floor ratchets: a
 * value written once outlives the rule that justified it, and the way back
 * down is to delete this package's rule and let it be written afresh.
 */
function noncurrentDays(
  rules: readonly LifecycleRule[],
  prefix: string,
  existing?: LifecycleRule,
): number {
  const held = rules
    .filter((rule) => governs(rule, prefix))
    .map((rule) => rule.NoncurrentVersionExpiration?.NoncurrentDays ?? 0);
  return Math.max(
    ...held,
    existing?.NoncurrentVersionExpiration?.NoncurrentDays ?? 0,
    S3_RELEASE_GRACE_DAYS,
  );
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

/** The rule to build: its id, its prefix, and the days after which current versions expire. */
interface RuleTarget {
  readonly id: string;
  readonly prefix: string;
  readonly days: number;
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
  rule: RuleTarget,
  rules: readonly LifecycleRule[],
  existing?: LifecycleRule,
): LifecycleRule {
  return {
    ...carried(existing),
    ID: rule.id,
    Filter: { Prefix: rule.prefix },
    Status: 'Enabled',
    Expiration: { Days: rule.days },
    NoncurrentVersionExpiration: {
      ...existing?.NoncurrentVersionExpiration,
      NoncurrentDays: noncurrentDays(rules, rule.prefix, existing),
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
 * Refuse to touch a rule that carries one of this prefix's ids but scopes a
 * different prefix. Three shapes reach here: slugging maps every
 * non-alphanumeric character to `-`, so `app/langgraph/` and `app-langgraph/`
 * produce one id; the marker rule appends `-markers`, so `app/`'s marker id is
 * the expiration id of `app-markers/`; and a rule written in the older schema
 * holds an id this package would take while naming its scope in the top-level
 * `Prefix`.
 *
 * Accepts: `rule` — the rule holding `id`, or nothing. `prefix` — the one this
 * call scopes rules to.
 *
 * Returns: nothing: `rule` is kept under its declared type, and this checks
 * it. A rule naming no scope anywhere is taken over, and so is one already
 * scoping this prefix — including in the older schema, which is then upgraded
 * to a filter.
 *
 * Throws: `VALIDATION` naming `s3.keyPrefix`. The id and the scope are
 * both bounded by {@link truncateForLog}: the scope is whatever the bucket's
 * lifecycle configuration holds, and the id is composed from an
 * `s3.keyPrefix` checked for shape and never for length.
 *
 * Guarantees: the scope is read wherever the rule names it, through the same
 * {@link scopeOf} the floor uses. Reading only `Filter.Prefix` let a rule in
 * the older schema through, and the rewrite then replaced its scope with this
 * one's — so the objects that rule governed silently lost their expiration,
 * and a bucket-wide rule was narrowed to this prefix.
 */
export function assertNoIdCollision(
  rule: LifecycleRule | undefined,
  prefix: string,
  id: string,
): void {
  if (rule === undefined) return;
  const found = scopeOf(rule);
  if (found === undefined || found === prefix) return;
  throw validationError(
    `the S3 lifecycle rule id "${truncateForLog(id)}" is already used by the prefix ` +
      `"${truncateForLog(found)}"; an id is the key ` +
      'prefix with every non-alphanumeric character replaced by "-", and the marker rule appends ' +
      '"-markers" to that, so "a/b/" takes the id of "a-b/" and "app/" takes the marker id of ' +
      '"app-markers/" — choose an s3.keyPrefix that produces neither id of any other prefix on ' +
      'this bucket',
    's3.keyPrefix',
  );
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

/**
 * Report whether `bucket` keeps versions, which is the whole of the recovery
 * window behind a released payload.
 *
 * Accepts: `bucket` — the offload bucket. `logger` — the adapter's; silent by
 * default, like every other event this package emits.
 *
 * Returns: nothing. A versioned bucket is silent; the other two states warn
 * and name their own remedy, because those remedies differ — a bucket that
 * never had versioning needs it enabled, while a suspended one needs it
 * re-enabled *and* an accounting of what suspension has already destroyed.
 *
 * Throws: nothing, deliberately. A failure of the call itself is a `warn` too,
 * including the `AccessDenied` of a role that provisioned lifecycle rules
 * yesterday without this action: a permission the call did not need then must
 * not break it now. This runs after the rules are written for the same reason
 * — a bucket that cannot answer still gets them.
 *
 * Guarantees: a bucket that has never been versioned answers with an empty
 * body, so the absent state is `Status === undefined`. It is never the string
 * `'Disabled'`, which this API does not return, and testing for one would read
 * an unversioned bucket as a versioned one.
 */
export async function reportBucketVersioning(
  client: S3Client,
  bucket: string,
  logger: Logger,
): Promise<void> {
  const { GetBucketVersioningCommand } = await loadS3Sdk();
  /**
   * `s3.bucketName` is checked for being a non-empty string and never for
   * length, so it reaches these three lines as whatever the caller's options
   * carried. It is quoted here as the identifier it is, cut at the log cap:
   * the line's job is to say which bucket to go and look at, and the bucket
   * holds the rest.
   */
  const named = truncateForLog(bucket);
  let status: string | undefined;
  try {
    status = (await client.send(new GetBucketVersioningCommand({ Bucket: bucket }))).Status;
  } catch (error) {
    /**
     * The error's name, never its message, which can carry credential text —
     * and read off a shape rather than an Error, because a client seam can
     * reject with anything at all and this function promises not to throw. Cut
     * like the bucket beside it: a name is a string the SDK or a client seam
     * produced, `message` is already bounded where `redactedMessage` relays
     * it, and the two are one value.
     */
    const reason = truncateForLog((error as { name?: string } | null)?.name ?? 'unknown');
    logger.warn(
      'ensureS3LifecycleRule: could not read the offload bucket versioning state, so whether a released payload is recoverable is unknown; the lifecycle rules were written, and the role needs s3:GetBucketVersioning',
      { bucket: named, reason },
    );
    return;
  }
  if (status === 'Enabled') return;
  if (status === undefined) {
    logger.warn(
      'ensureS3LifecycleRule: versioning is off on the offload bucket, so releasing a payload deletes it outright with no recovery window; enable bucket versioning to gain one',
      { bucket: named },
    );
    return;
  }
  logger.warn(
    'ensureS3LifecycleRule: versioning is suspended on the offload bucket, so releasing a payload deletes it outright; re-enable versioning, and note that the payloads released while it was suspended are already gone',
    { bucket: named },
  );
}
