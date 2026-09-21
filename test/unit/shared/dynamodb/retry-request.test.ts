/**
 * The seam that carries a caller's `AbortSignal` into the request itself.
 *
 * `withRetry` hands each attempt the SDK's own second argument, because a call
 * site's `fn` closes over its own parameters and nothing else reaches it. What
 * is asserted here is the contract the thirty-three call sites rely on: the
 * object arrives, it carries the signal the caller gave, and a failure while
 * that signal is set is reported as the cancel it is.
 */
import { type SdkRequestOptions, withRetry } from '../../../../src/shared/dynamodb/retry';
import { isDynamoDBLangGraphError } from '../../../../src/shared/errors/base-error';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { RetryExhaustedError } from '../../../../src/shared/errors/errors';

const throttled = (): Error =>
  Object.assign(new Error('throttled'), { name: 'ThrottlingException' });

/** What the SDK rejects a cancelled request with: a name, and no code of its own. */
const sdkAbort = (): Error => Object.assign(new Error('Request aborted'), { name: 'AbortError' });

describe('the request options withRetry hands each attempt', () => {
  it('carries the caller signal, so the SDK can cancel the request in flight', async () => {
    const controller = new AbortController();
    const seen: SdkRequestOptions[] = [];
    await withRetry(
      async (request) => {
        seen.push(request);
        return 'ok';
      },
      { signal: controller.signal },
    );
    expect(seen).toEqual([{ abortSignal: controller.signal }]);
  });

  /**
   * One object for the whole operation, not one per attempt: a re-send cannot
   * then differ from the send before it, which for a write carrying a client
   * request token is the difference between a deduplicated re-send and an
   * `IdempotentParameterMismatchException`.
   */
  it('is the same object on every attempt of one budget', async () => {
    const controller = new AbortController();
    const seen: SdkRequestOptions[] = [];
    let calls = 0;
    await withRetry(
      async (request) => {
        seen.push(request);
        calls += 1;
        if (calls < 3) throw throttled();
        return 'ok';
      },
      { signal: controller.signal, baseDelayMs: 0, rng: () => 0 },
    );
    expect(seen).toHaveLength(3);
    expect(seen[1]).toBe(seen[0]);
    expect(seen[2]).toBe(seen[0]);
  });

  /**
   * A call site forwards what it is given unconditionally, so the no-signal
   * case has to be a request the SDK accepts rather than something the site
   * must branch on.
   */
  it('carries an undefined signal when the caller gave none', async () => {
    const seen: SdkRequestOptions[] = [];
    await withRetry(async (request) => {
      seen.push(request);
      return 1;
    });
    expect(seen).toEqual([{ abortSignal: undefined }]);
  });

  /** A call site that makes no cancellable call still compiles and still runs. */
  it('leaves an attempt that ignores it exactly as it was', async () => {
    await expect(withRetry(async () => 'unchanged')).resolves.toBe('unchanged');
  });
});

describe('an attempt that fails while the signal is set', () => {
  it('is reported as the library AbortError, not as the transport failure', async () => {
    const controller = new AbortController();
    const error = (await withRetry(
      async () => {
        controller.abort();
        throw sdkAbort();
      },
      { signal: controller.signal, baseDelayMs: 0, rng: () => 0 },
    ).catch((e: Error) => e)) as Error & { code?: string };
    expect(isDynamoDBLangGraphError(error)).toBe(true);
    expect(error).toMatchObject({ code: ErrorCode.ABORTED, name: 'AbortError' });
  });

  /**
   * The mid-body case. A request cut after its headers arrived rejects as a
   * socket error, which every classifier in this package reads as transient —
   * so without the signal being read first, a cancel would spend the whole
   * budget re-sending against a signal that had already fired.
   */
  it('spends no further attempt on a socket error the classifier calls transient', async () => {
    const controller = new AbortController();
    let calls = 0;
    const error = (await withRetry(
      async () => {
        calls += 1;
        controller.abort();
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      },
      { signal: controller.signal, maxAttempts: 5, baseDelayMs: 0, rng: () => 0 },
    ).catch((e: Error) => e)) as Error & { code?: string };
    expect(calls).toBe(1);
    expect(error.code).toBe(ErrorCode.ABORTED);
    expect(error).not.toBeInstanceOf(RetryExhaustedError);
  });

  /** A signal that has not fired changes nothing: the failure is classified as it always was. */
  it('is classified as usual while the signal is merely present', async () => {
    const controller = new AbortController();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls += 1;
          throw throttled();
        },
        { signal: controller.signal, maxAttempts: 2, baseDelayMs: 0, rng: () => 0 },
      ),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
    expect(calls).toBe(2);
  });
});
