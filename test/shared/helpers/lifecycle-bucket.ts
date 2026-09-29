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
 * Runs `fn` under fake timers, advanced once safely past the whole lifecycle
 * backoff ladder (1+2+4+8 s), so a real `sleep`-based wait inside it settles
 * at once instead of costing real wall-clock time. `ensureS3LifecycleRule()`
 * has no `pace` of its own to inject on any adapter — it is an internal seam
 * — so a test that reaches a public method's own default wait needs this
 * rather than an injected one.
 *
 * Unlike mocking `sleep` itself, this leaves the real function in place: an
 * `AbortSignal` passed through a wait behaves exactly as it does outside a
 * test. It is not free of side effects on everything else, though:
 * `jest.useFakeTimers()` fakes every timer API, `process.nextTick`,
 * `queueMicrotask` and `Date` for the whole process while it is active, not
 * only for `fn` — which overrides the frozen `Date.now` every test already
 * gets from `test-setup.ts` for as long as this call is in flight. A
 * DynamoDB retry backoff or an S3 transfer retry `fn` itself starts is still
 * only faked for that same window, and keeps its own real timing once this
 * returns.
 */
export async function fastLifecyclePoll<T>(fn: () => Promise<T>): Promise<T> {
  jest.useFakeTimers();
  const result = fn();
  // Marked handled at once, before advancing the clock can carry this
  // function past the tick a rejection lands on: Jest 30 charges an
  // unhandled rejection to the test the moment one goes unclaimed at a
  // microtask checkpoint, and nothing has looked at `result` yet at that
  // point — a caller awaiting this function's own return, further down the
  // same tick, is too late to prevent that charge. The real rejection this
  // function returns is untouched by this.
  result.catch(() => {});
  try {
    // A few seconds past the ladder's exact 15 s sum, not equal to it: the
    // last wait is armed relative to when its own `sleep` call starts, which
    // is a tick or two after this function's own start, so advancing by
    // exactly the nominal sum risks landing just short of when it fires.
    await jest.advanceTimersByTimeAsync(20_000);
  } finally {
    // Independent of whether `result` has settled: a wrapped call that never
    // resolves must not leave fake timers switched on for every test that
    // runs after it in this file.
    jest.useRealTimers();
  }
  return result;
}
