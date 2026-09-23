import { lifecycleExpirationDays } from '../../shared/validation/ttl';
import type { CheckpointerContext } from '../internal/setup';

/**
 * Provision an S3 lifecycle expiration rule on the offload bucket matching the
 * configured TTL, so an offloaded payload does not outlive the DynamoDB item
 * that points at it.
 *
 * A no-op unless both S3 offload and a TTL are configured: without offload
 * there is no bucket to rule over, and without a TTL no item expires, so any
 * rule would delete a payload a live item still needs.
 *
 * The rule is expressed in whole days because that is the only granularity S3
 * lifecycle expiration accepts, while the DynamoDB TTL is in seconds; see
 * `lifecycleExpirationDays` for the rounding, which is always up.
 *
 * Accepts: the adapter's context. A no-op unless both S3 offload and a TTL are
 * configured: without offload there is no bucket to rule over, and without a
 * TTL no item expires, so any rule would delete a payload a live item still
 * needs.
 *
 * Returns: nothing. Installing a rule that is already there is a no-op too, so
 * calling this on every deploy is safe.
 *
 * Throws: whatever reading or writing the bucket's lifecycle configuration
 * throws, and `VALIDATION` naming `s3.keyPrefix` when the rule id this
 * prefix would take is already held by a different prefix.
 *
 * Guarantees: needs the bucket-level `s3:GetLifecycleConfiguration` /
 * `s3:PutLifecycleConfiguration` permissions, which are broader than the
 * object-level CRUD the rest of offload uses — so this is a provisioning call,
 * not a per-request one.
 */
export async function ensureS3Lifecycle(context: CheckpointerContext): Promise<void> {
  if (!context.offloader || !context.ttl) return;
  await context.offloader.ensureLifecycleRule(lifecycleExpirationDays(context.ttl), context.logger);
}
