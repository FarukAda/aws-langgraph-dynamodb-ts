import type { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';

import { DEFAULT_S3_KEY_PREFIX } from '../../constants';
import { s3ClientOptions } from './client-types';
import { defaultAdapterKeyPrefix, type S3OffloadConfig } from './config';

/** The adapters that share one bucket, each under its own default key prefix. */
export type AdapterName = 'checkpointer' | 'store' | 'history';

/**
 * An adapter's `s3` option resolved into the offloader's configuration.
 *
 * Accepts: `s3` — as the caller gave it. `adapter` — names the default key
 * prefix, so three adapters sharing one bucket do not share a path.
 * `clientConfig` — the adapter's DynamoDB client config, read for its region
 * only.
 *
 * Returns: `s3` with `keyPrefix` defaulted to the adapter's own path, and
 * `clientConfig.region` filled in from the DynamoDB side when the S3 config
 * names none. With no region on either side the field is left absent and the
 * SDK resolves it from the environment.
 *
 * Throws: nothing.
 *
 * Guarantees: a bucket reachable only through the region the DynamoDB side was
 * configured with is addressed in that region. The S3 SDK does not follow
 * region redirects, so such a bucket otherwise failed with an opaque
 * `PermanentRedirect` on the first offload.
 */
export function offloaderConfigFor(
  s3: S3OffloadConfig,
  adapter: AdapterName,
  clientConfig?: DynamoDBClientConfig,
): S3OffloadConfig {
  const region = s3ClientOptions(s3.clientConfig).region ?? clientConfig?.region;
  return {
    ...s3,
    keyPrefix: s3.keyPrefix ?? defaultAdapterKeyPrefix(DEFAULT_S3_KEY_PREFIX, adapter),
    ...(region === undefined ? {} : { clientConfig: { ...s3.clientConfig, region } }),
  };
}
