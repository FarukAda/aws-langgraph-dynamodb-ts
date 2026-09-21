import type { S3Client } from '@aws-sdk/client-s3';

import type { Logger } from '../../logging/logger';
import { truncateForLog } from '../../logging/truncate';
import { loadS3Sdk } from './client';

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
