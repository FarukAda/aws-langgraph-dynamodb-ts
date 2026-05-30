import { withDynamoDBRetry, withRetry } from '../../../../src/shared/dynamodb/retry';
import { AbortError, RetryExhaustedError } from '../../../../src/shared/errors/errors';

const retryable = (): Error =>
  Object.assign(new Error('throttled'), { name: 'ThrottlingException' });

describe('withRetry', () => {
  it('returns the result on first success', async () => {
    await expect(withRetry(async () => 7)).resolves.toBe(7);
  });

  it('retries a retryable error then succeeds', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw retryable();
        return 'ok';
      },
      { rng: () => 0, baseDelayMs: 0 },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('re-throws a non-retryable error unchanged', async () => {
    const permanent = Object.assign(new Error('nope'), { name: 'ValidationException' });
    await expect(
      withRetry(async () => {
        throw permanent;
      }),
    ).rejects.toBe(permanent);
  });

  it('throws RetryExhaustedError after the attempt budget', async () => {
    await expect(
      withRetry(
        async () => {
          throw retryable();
        },
        { maxAttempts: 2, rng: () => 0, baseDelayMs: 0 },
      ),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
  });

  it('throws AbortError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(withRetry(async () => 1, { signal: controller.signal })).rejects.toBeInstanceOf(
      AbortError,
    );
  });

  it('preserves the last error as the cause of RetryExhaustedError', async () => {
    const last = retryable();
    let thrown: RetryExhaustedError | undefined;
    try {
      await withRetry(
        async () => {
          throw last;
        },
        { maxAttempts: 1, rng: () => 0, baseDelayMs: 0 },
      );
    } catch (error) {
      thrown = error as RetryExhaustedError;
    }
    expect(thrown).toBeInstanceOf(RetryExhaustedError);
    expect(thrown?.cause).toBe(last);
    expect(thrown?.context.attempts).toBe(1);
  });

  it('normalizes a thrown non-Error value before classifying it', async () => {
    await expect(
      withRetry(async () => {
        throw 'plain string failure';
      }),
    ).rejects.toThrow('plain string failure');
  });
});

describe('withDynamoDBRetry', () => {
  it('resolves the wrapped function result with default options', async () => {
    await expect(withDynamoDBRetry(async () => 'value')).resolves.toBe('value');
  });

  it('honors overrides such as maxAttempts', async () => {
    await expect(
      withDynamoDBRetry(
        async () => {
          throw retryable();
        },
        { maxAttempts: 1, rng: () => 0, baseDelayMs: 0 },
      ),
    ).rejects.toBeInstanceOf(RetryExhaustedError);
  });
});
