import type {
  LifecycleRule,
  S3Client,
  TransitionDefaultMinimumObjectSize,
} from '@aws-sdk/client-s3';

import { ValidationError } from '../../errors/errors';
import { loadS3Sdk } from './client';
import { assertScopedKeyPrefix, buildLifecycleRuleId } from './config';

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

function alreadyCorrect(rule: LifecycleRule | undefined, prefix: string, days: number): boolean {
  return (
    rule?.Status === 'Enabled' &&
    rule.Filter?.Prefix === prefix &&
    rule.Expiration?.Days === days &&
    rule.NoncurrentVersionExpiration?.NoncurrentDays === days
  );
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
 * Ensure a `days`-day expiration rule scoped to `prefix` exists on `bucket`.
 *
 * Accepts: `prefix` — re-checked for scoping here, because this rule is the one
 * place an unscoped prefix would destroy data outside this library's. `days` —
 * applied to both current and noncurrent versions, so a versioned bucket does
 * not retain every superseded payload forever; the noncurrent field is inert on
 * an unversioned bucket.
 *
 * Returns: nothing. Idempotent: a rule already scoped to `prefix` with these
 * days is left untouched and no write is issued.
 *
 * Throws: ValidationError naming `s3.keyPrefix` for an unscoped prefix, or when
 * the rule id this prefix produces is already held by a different prefix (see
 * {@link assertNoIdCollision}); otherwise whatever the SDK rejects with. A
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
  const ruleId = buildLifecycleRuleId(prefix);
  const state = await readState(client, bucket);
  const existing = state.rules.find((rule) => rule.ID === ruleId);
  assertNoIdCollision(existing, prefix, ruleId);
  if (alreadyCorrect(existing, prefix, days)) return;
  const newRule: LifecycleRule = {
    ID: ruleId,
    Filter: { Prefix: prefix },
    Status: 'Enabled',
    Expiration: { Days: days },
    NoncurrentVersionExpiration: { NoncurrentDays: days },
  };
  const merged = existing
    ? state.rules.map((rule) => (rule.ID === ruleId ? newRule : rule))
    : [...state.rules, newRule];
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
