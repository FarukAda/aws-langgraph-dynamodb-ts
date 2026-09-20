import type {
  LifecycleRule,
  S3Client,
  TransitionDefaultMinimumObjectSize,
} from '@aws-sdk/client-s3';

import type { Logger } from '../../logging/logger';
import { loadS3Sdk } from './client';
import { assertScopedKeyPrefix, buildLifecycleRuleId, buildMarkerRuleId } from './config';
import { alreadyCorrect, assertNoIdCollision, markerRule, ttlRule } from './rules';
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

/**
 * Ensure the two rules scoped to `prefix` exist on `bucket`: a `days`-day
 * expiration for current versions, and the reclaim that removes the delete
 * marker a released payload leaves behind.
 *
 * Accepts: `prefix` — re-checked for scoping here, because these rules are the
 * one place an unscoped prefix would destroy data outside this library's.
 * `days` — the current-version expiry only. Released versions are governed by
 * the release grace instead (see {@link ttlRule}), which is a floor measured
 * against every rule already governing these keys. Both are inert on an
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
  const reclaim = markerRule(markerId, prefix, heldMarker);
  if (!alreadyCorrect(heldTtl, expiry) || !alreadyCorrect(heldMarker, reclaim)) {
    await putRules(client, bucket, state, upsert(upsert(state.rules, expiry), reclaim));
  }
  await reportBucketVersioning(client, bucket, logger);
}
