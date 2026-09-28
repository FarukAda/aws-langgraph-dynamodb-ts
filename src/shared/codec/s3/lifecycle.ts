/**
 * Hides the bucket lifecycle configuration this package maintains.
 *
 * Two rules per prefix — one expiring objects a day after the ttl plus the
 * sweep margin and keeping a released payload's noncurrent version for a grace
 * window, one reclaiming expired delete markers — are written without
 * disturbing any other rule on the bucket, rewritten only when they differ.
 * Each write is checked by a re-read, built fresh each time rather than from
 * a plan a wait has gone stale, so a rule that appeared during that wait is
 * carried forward rather than overwritten; this is followed by a report of
 * whether the bucket keeps versions at all.
 */

import type {
  LifecycleRule,
  S3Client,
  TransitionDefaultMinimumObjectSize,
} from '@aws-sdk/client-s3';

import { sleep } from '../../dynamodb/retry';
import { DynamoDBLangGraphError } from '../../errors/base-error';
import { isMissingLifecycleConfiguration } from '../../errors/classify';
import { ErrorCode } from '../../errors/error-code';
import { validationError } from '../../errors/errors';
import type { Logger } from '../../logging/logger';
import { truncateForLog } from '../../logging/truncate';
import { loadS3Sdk } from './client';
import { assertScopedKeyPrefix, buildLifecycleRuleId, buildMarkerRuleId } from './config';

/**
 * Days a released payload's noncurrent version survives behind its delete
 * marker before S3 reclaims it. One day is the smallest the lifecycle API
 * accepts and it rounds up to the next UTC midnight, so the window is 24-48 h:
 * long enough to restore a payload released in error, short enough that a
 * versioned bucket does not pay for every release it has ever made. It is a
 * floor and never a cap — a longer retention the bucket already carries is
 * kept, because this package has no business shortening someone else's
 * recovery window. Inert on an unversioned bucket, which has no noncurrent
 * versions to expire.
 */
export const S3_RELEASE_GRACE_DAYS = 1;

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

/** Rounds {@link ensureLifecycleRule} polls before it reports a writer it cannot outlast. */
export const LIFECYCLE_SETTLE_WRITES = 5;

/** The wait before the first re-read of a write not yet confirmed, doubling each time. */
const LIFECYCLE_SETTLE_BASE_MS = 1_000;

/** How {@link ensureLifecycleRule} waits between re-reads; a test passes one that takes no time. */
export interface LifecyclePace {
  wait?: (delayMs: number) => Promise<void>;
}

/** The two rule ids a prefix takes. */
interface RuleIds {
  ttl: string;
  marker: string;
}

/**
 * The configuration to write for `state`, and whether it already holds both
 * rules as they should be — in which case nothing is written.
 */
function planRules(
  state: LifecycleState,
  target: LifecycleTarget,
  ids: RuleIds,
): { settled: boolean; rules: LifecycleRule[] } {
  const heldTtl = state.rules.find((rule) => rule.ID === ids.ttl);
  const heldMarker = state.rules.find((rule) => rule.ID === ids.marker);
  assertNoIdCollision(heldTtl, target.prefix, ids.ttl);
  assertNoIdCollision(heldMarker, target.prefix, ids.marker);
  const expiry = ttlRule(
    { id: ids.ttl, prefix: target.prefix, days: target.days },
    state.rules,
    heldTtl,
  );
  const reclaim = markerRule(ids.marker, target.prefix, heldMarker);
  return {
    settled: alreadyCorrect(heldTtl, expiry) && alreadyCorrect(heldMarker, reclaim),
    rules: upsert(upsert(state.rules, expiry), reclaim),
  };
}

/** The wait before an attempt's re-read (1-indexed), doubling from {@link LIFECYCLE_SETTLE_BASE_MS}. */
function delayForAttempt(attempt: number): number {
  return LIFECYCLE_SETTLE_BASE_MS * 2 ** (attempt - 1);
}

/**
 * A rule's content the way {@link sameRuleSet} compares it: its id and the
 * fields anything on this bucket is likely to set, normalised so neither a
 * field this package does not manage nor how S3 happens to format it reads
 * as a change nobody made.
 */
function ruleFingerprint(rule: LifecycleRule): string {
  return JSON.stringify([
    rule.ID,
    rule.Status,
    scopeOf(rule),
    rule.Expiration?.Days,
    rule.Expiration?.ExpiredObjectDeleteMarker,
    rule.Expiration?.Date,
    rule.NoncurrentVersionExpiration?.NoncurrentDays,
  ]);
}

/**
 * Whether two reads of a bucket's lifecycle configuration hold the same
 * rules — compared by id and content, never by array order, so a read that
 * merely lists the same rules in a different position does not read as a
 * change nobody made.
 *
 * Accepts: `a`, `b` — two rule sets, read moments apart.
 *
 * Returns: whether every id present in either one carries the same
 * {@link ruleFingerprint} in both.
 *
 * Throws: nothing.
 */
function sameRuleSet(a: readonly LifecycleRule[], b: readonly LifecycleRule[]): boolean {
  const fingerprint = (rules: readonly LifecycleRule[]): string =>
    rules.map(ruleFingerprint).sort().join('\n');
  return fingerprint(a) === fingerprint(b);
}

/** The error for a competing writer this call could not outlast through {@link LIFECYCLE_SETTLE_WRITES} writes. */
function lifecycleContention(target: LifecycleTarget): DynamoDBLangGraphError {
  return new DynamoDBLangGraphError(
    `the lifecycle configuration of bucket ${truncateForLog(target.bucket)} kept losing the ` +
      `rules for ${truncateForLog(target.prefix)} to a different configuration on every one of ` +
      `${LIFECYCLE_SETTLE_WRITES} writes: another writer is replacing it at the same time; run ` +
      'ensureS3LifecycleRule again once it has finished',
    ErrorCode.CONTENTION,
    {},
  );
}

/**
 * Warn that this call wrote its rules but a re-read never showed them within
 * the polling window, and return rather than throw: AWS documents that a
 * bucket's lifecycle configuration can take a few minutes to propagate, so a
 * window of a few seconds finding nothing is expected lag, not evidence of a
 * competing writer — see {@link ensureLifecycleRule}'s own doc comment for
 * the citation.
 */
function warnLifecyclePending(target: LifecycleTarget, logger: Logger): void {
  logger.warn(
    'ensureS3LifecycleRule: wrote the lifecycle rules but a re-read did not show them within the ' +
      'polling window; S3 documents that propagation can take a few minutes, so this is most ' +
      'likely lag rather than a lost write — call ensureS3LifecycleRule() again later to confirm',
    { bucket: truncateForLog(target.bucket), prefix: truncateForLog(target.prefix) },
  );
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
 * and leaves no marker. `pace.wait` — how to wait between re-reads; the
 * default sleeps.
 *
 * Returns: nothing. Idempotent: when both rules already say this, no write is
 * issued. Otherwise it writes them, waits, and re-reads. A bucket's
 * configuration is served eventually consistently rather than
 * read-your-writes
 * (https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html, "Amazon
 * S3 data consistency model": "Bucket configurations have an eventual
 * consistency model"), and S3 documents specifically that a lifecycle
 * configuration can take a few minutes to fully propagate
 * (https://docs.aws.amazon.com/AmazonS3/latest/userguide/how-to-set-lifecycle-configuration-intro.html,
 * "Lifecycle configuration propagation delay"). So a re-read that still shows
 * exactly what was read before this call's last write is treated as that lag,
 * not as loss, and prompts another wait rather than another write; a re-read
 * that instead shows some *other* configuration, still without this call's
 * rules, is a competing writer, and the rules are written again, merged with
 * whatever that read now holds. The waits (1, 2, 4, 8 s) and the five-round
 * limit are this library's own polling policy — a choice, not a bound AWS
 * documents. If the window ends on lag rather than a competing writer, this
 * logs a `warn` and returns rather than throwing: the rules were written,
 * only their visibility could not be confirmed here, and a later call (or the
 * same one, run again) can still find them settled. The bucket's versioning
 * state is reported in every case, because the containment a released payload
 * depends on is missing or present regardless of whether this particular call
 * had a rule to write or could confirm one.
 *
 * Throws: `VALIDATION` naming `s3.keyPrefix` for an unscoped prefix, or when
 * either rule id this prefix produces is already held by a different prefix
 * (see {@link assertNoIdCollision}); `CONTENTION` when a re-read keeps showing
 * a competing writer's configuration through {@link LIFECYCLE_SETTLE_WRITES}
 * writes; otherwise whatever the SDK rejects with. A bucket with no lifecycle
 * configuration at all is not an error — S3 reports
 * `NoSuchLifecycleConfiguration` and this starts from an empty rule set.
 *
 * Guarantees: rules this package did not write are preserved, and so is the
 * bucket-level `TransitionDefaultMinimumObjectSize` — a Put replaces the whole
 * configuration, so dropping it would silently reset the bucket to the
 * default. Each write is built from a re-read taken right before it, never
 * from a plan built before that read's wait, so a rule a competing writer
 * added during the wait is carried into this call's own write instead of
 * being silently overwritten by a stale plan. That protection covers only
 * this call's own polling, though: a first read that already raced a
 * different call's write is not detected, so provisioning callers still need
 * to run one at a time, and re-run each once every one of them has run when
 * more than one adapter or process shares a bucket.
 */
export async function ensureLifecycleRule(
  client: S3Client,
  target: LifecycleTarget,
  logger: Logger,
  pace: LifecyclePace = {},
): Promise<void> {
  assertScopedKeyPrefix(target.prefix);
  const ids = {
    ttl: buildLifecycleRuleId(target.prefix),
    marker: buildMarkerRuleId(target.prefix),
  };
  const wait = pace.wait ?? ((delayMs: number) => sleep(delayMs));
  let before: readonly LifecycleRule[] = [];
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) await wait(delayForAttempt(attempt));
    const state = await readState(client, target.bucket);
    const plan = planRules(state, target, ids);
    if (plan.settled) break;
    const lastAttempt = attempt === LIFECYCLE_SETTLE_WRITES - 1;
    if (attempt > 0 && sameRuleSet(state.rules, before)) {
      if (lastAttempt) {
        warnLifecyclePending(target, logger);
        await reportBucketVersioning(client, target.bucket, logger);
        return;
      }
      logger.debug(
        'ensureS3LifecycleRule: a re-read still shows what was there before this write; ' +
          'waiting for it to propagate',
        { attempt, delayMs: delayForAttempt(attempt) },
      );
      continue;
    }
    if (attempt > 0) {
      logger.debug(
        'ensureS3LifecycleRule: a re-read shows a different configuration without these ' +
          'rules; writing them again',
        { attempt, delayMs: delayForAttempt(attempt) },
      );
    }
    await putRules(client, target.bucket, state, plan.rules);
    before = state.rules;
    if (lastAttempt) throw lifecycleContention(target);
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
 * {@link scopeOf} the floor uses. Reading only `Filter.Prefix` would let a
 * rule in the older schema through, and the rewrite would then replace its
 * scope with this one's — so the objects that rule governs would silently
 * lose their expiration, and a bucket-wide rule would narrow to this prefix.
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
  // `s3.bucketName` is checked for being a non-empty string and never for
  // length, so it reaches these three lines as whatever the caller's options
  // carried. It is quoted here as the identifier it is, cut at the log cap:
  // the line's job is to say which bucket to go and look at, and the bucket
  // holds the rest.
  const named = truncateForLog(bucket);
  let status: string | undefined;
  try {
    status = (await client.send(new GetBucketVersioningCommand({ Bucket: bucket }))).Status;
  } catch (error) {
    // The error's name, never its message, which can carry credential text —
    // and read off a shape rather than an Error, because a client seam can
    // reject with anything at all and this function promises not to throw. Cut
    // like the bucket beside it: a name is a string the SDK or a client seam
    // produced, `message` is already bounded where `redactedMessage` relays
    // it, and the two are one value.
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
