import type { DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';

import { DEFAULT_S3_KEY_PREFIX } from '../../constants';
import { defaultAdapterKeyPrefix, type S3OffloadConfig } from './config';

/** The adapters that share one bucket, each under its own default key prefix. */
export type AdapterName = 'checkpointer' | 'store' | 'history';

/**
 * Resolve an adapter's `s3` option into the offloader's configuration: the
 * adapter-scoped default key prefix when none is given, and the DynamoDB
 * client's region when the S3 client config names none. The S3 SDK does not
 * follow region redirects by default, so a bucket reachable only through the
 * region the DynamoDB side was configured with used to fail with an opaque
 * `PermanentRedirect` on the first offload.
 */
export function offloaderConfigFor(
  s3: S3OffloadConfig,
  adapter: AdapterName,
  clientConfig?: DynamoDBClientConfig,
): S3OffloadConfig {
  const region = s3.clientConfig?.region ?? clientConfig?.region;
  return {
    ...s3,
    keyPrefix: s3.keyPrefix ?? defaultAdapterKeyPrefix(DEFAULT_S3_KEY_PREFIX, adapter),
    ...(region === undefined ? {} : { clientConfig: { ...s3.clientConfig, region } }),
  };
}
