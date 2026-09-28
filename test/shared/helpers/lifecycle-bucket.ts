import {
  GetBucketLifecycleConfigurationCommand,
  type LifecycleRule,
  PutBucketLifecycleConfigurationCommand,
  type PutBucketLifecycleConfigurationCommandInput,
  type S3Client,
} from '@aws-sdk/client-s3';
import type { AwsClientStub } from 'aws-sdk-client-mock';

/** What a bucket's lifecycle configuration holds, as a read answers it. */
export interface HeldLifecycle {
  Rules?: LifecycleRule[];
  TransitionDefaultMinimumObjectSize?: string;
}

/**
 * Answer a bucket's lifecycle reads from its last lifecycle write, as S3 does
 * once a write has propagated. `initial` is what the bucket holds before any
 * write; absent, a read answers `NoSuchLifecycleConfiguration`, as a bucket
 * that never had one does. Returns the writes seen, in order.
 */
export function lifecycleBucket(
  s3Mock: AwsClientStub<S3Client>,
  initial?: HeldLifecycle,
): HeldLifecycle[] {
  const writes: HeldLifecycle[] = [];
  let held = initial;
  s3Mock.on(GetBucketLifecycleConfigurationCommand).callsFake(() => {
    if (held === undefined) {
      throw Object.assign(new Error('The lifecycle configuration does not exist'), {
        name: 'NoSuchLifecycleConfiguration',
      });
    }
    return held;
  });
  s3Mock
    .on(PutBucketLifecycleConfigurationCommand)
    .callsFake((input: PutBucketLifecycleConfigurationCommandInput) => {
      held = {
        Rules: input.LifecycleConfiguration?.Rules ?? [],
        ...(input.TransitionDefaultMinimumObjectSize === undefined
          ? {}
          : { TransitionDefaultMinimumObjectSize: input.TransitionDefaultMinimumObjectSize }),
      };
      writes.push(held);
      return {};
    });
  return writes;
}
