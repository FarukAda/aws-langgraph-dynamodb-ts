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

/**
 * Runs `fn` under fake timers, advanced once past the whole lifecycle
 * backoff ladder (1+2+4+8 s), so a real `sleep`-based wait inside it settles
 * at once instead of costing real wall-clock time. `ensureS3LifecycleRule()`
 * has no `pace` of its own to inject on any adapter — it is an internal seam
 * — so a test that reaches a public method's own default wait needs this
 * rather than an injected one.
 *
 * Unlike mocking `sleep` itself, this leaves the real function in place: an
 * `AbortSignal` passed through a wait behaves exactly as it does outside a
 * test, and nothing beside the lifecycle call `fn` makes is affected — a
 * DynamoDB retry backoff or an S3 transfer retry started elsewhere keeps its
 * own real timing.
 */
export async function fastLifecyclePoll<T>(fn: () => Promise<T>): Promise<T> {
  jest.useFakeTimers();
  try {
    const result = fn();
    await jest.advanceTimersByTimeAsync(15_000);
    return await result;
  } finally {
    jest.useRealTimers();
  }
}
