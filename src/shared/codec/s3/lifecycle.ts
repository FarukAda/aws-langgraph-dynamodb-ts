import type {
  LifecycleRule,
  S3Client,
  TransitionDefaultMinimumObjectSize,
} from '@aws-sdk/client-s3';

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

function alreadyCorrect(rule: LifecycleRule | undefined, days: number): boolean {
  return (
    rule?.Status === 'Enabled' &&
    rule.Expiration?.Days === days &&
    rule.NoncurrentVersionExpiration?.NoncurrentDays === days
  );
}

/**
 * Idempotently ensure a `days`-day expiration lifecycle rule exists for
 * `prefix`. Reads existing rules, preserves user-defined ones and the
 * bucket-level `TransitionDefaultMinimumObjectSize` (a Put replaces the whole
 * configuration, so dropping it would reset the bucket to the default), and
 * only adds/updates the library's prefix-scoped rule.
 *
 * Noncurrent versions expire after the same number of days, so a versioned
 * bucket does not retain every superseded payload forever; the field is inert
 * on an unversioned bucket. The prefix is re-checked here because this rule is
 * the one place an unscoped prefix would destroy data outside this library's.
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
  if (alreadyCorrect(existing, days)) return;
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
