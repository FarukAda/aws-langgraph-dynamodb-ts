import {
  MAX_WRITE_LIFETIME_MS,
  TOKEN_IDEMPOTENCY_WINDOW_MS,
} from '../../../../src/shared/constants';
import { withDynamoDBRetry, withRetry } from '../../../../src/shared/dynamodb/retry';
import { isDynamoDBLangGraphError } from '../../../../src/shared/errors/base-error';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
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

describe('withRetry isRetryable predicate', () => {
  it('lets a predicate decide instead of the signal list', async () => {
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error('custom-transient');
        return 'ok';
      },
      {
        rng: () => 0,
        baseDelayMs: 0,
        isRetryable: (error) => error.message === 'custom-transient',
      },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('rethrows immediately when the predicate rejects a signal the list would retry', async () => {
    await expect(
      withRetry(
        async () => {
          throw Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
        },
        { baseDelayMs: 0, isRetryable: () => false },
      ),
    ).rejects.toMatchObject({ name: 'ThrottlingException' });
  });
});

describe('withRetry onRetry hook (DDB-10)', () => {
  it('reports each retry with the attempt, the delay about to be slept and the error', async () => {
    const onRetry = jest.fn();
    const failing = Object.assign(new Error('throttled'), { name: 'ThrottlingException' });
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw failing;
        return 'ok';
      },
      { rng: () => 1, baseDelayMs: 10, onRetry },
    );
    expect(onRetry.mock.calls.map(([info]) => info)).toEqual([
      { attempt: 1, delayMs: 10, error: failing },
      { attempt: 2, delayMs: 20, error: failing },
    ]);
  });
});

describe('withRetry abort normalisation (DDB-05)', () => {
  const throttled = (): Error =>
    Object.assign(new Error('throttled'), { name: 'ThrottlingException' });

  it('rejects with the library AbortError when the signal aborts during a backoff sleep', async () => {
    const controller = new AbortController();
    const run = withRetry(
      async () => {
        setTimeout(() => controller.abort(), 0);
        throw throttled();
      },
      { signal: controller.signal, rng: () => 1, baseDelayMs: 1000 },
    );
    const error = (await run.catch((e: Error) => e)) as Error & { code?: string; cause?: Error };
    expect(isDynamoDBLangGraphError(error)).toBe(true);
    expect(error).toMatchObject({ code: ErrorCode.ABORTED, name: 'AbortError' });
    expect(error.cause?.name).toBe('AbortError');
  });

  it('wraps a pre-aborted signal the same way', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(withRetry(async () => 1, { signal: controller.signal })).rejects.toMatchObject({
      code: ErrorCode.ABORTED,
      name: 'AbortError',
      cause: expect.objectContaining({ name: 'AbortError' }),
    });
  });

  it('rethrows a library AbortError given as the abort reason unchanged', async () => {
    const reason = new AbortError('caller cancelled');
    const controller = new AbortController();
    controller.abort(reason);
    await expect(withRetry(async () => 1, { signal: controller.signal })).rejects.toBe(reason);
  });
});

describe('withRetry under a deadline', () => {
  const failing = async (): Promise<never> => {
    throw retryable();
  };

  /**
   * The margin is what makes a retried write safe to re-send: the whole budget
   * plus the attempt in flight when it expires still ends inside the window a
   * client request token is honoured for.
   */
  it('bounds a write to half the token idempotency window', () => {
    expect(TOKEN_IDEMPOTENCY_WINDOW_MS).toBe(600_000);
    expect(MAX_WRITE_LIFETIME_MS).toBe(300_000);
    expect(MAX_WRITE_LIFETIME_MS * 2).toBe(TOKEN_IDEMPOTENCY_WINDOW_MS);
  });

  it('spends no attempt past a deadline that has already gone by', async () => {
    let calls = 0;
    const error = (await withRetry(
      async () => {
        calls += 1;
        return failing();
      },
      { maxAttempts: 3, baseDelayMs: 0, rng: () => 1, deadlineAt: Date.now() - 1 },
    ).catch((e: Error) => e)) as RetryExhaustedError;
    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(RetryExhaustedError);
    expect(error.context.attempts).toBe(1);
    expect(error.message).toContain('after 1 attempts');
  });

  /**
   * The first sleep (500ms) fits inside the 1000ms budget and the second
   * (1000ms) reaches it on its own, so the cut lands on attempt 2 by
   * arithmetic rather than by how long anything really took.
   */
  it('cuts the budget before a sleep that would cross the deadline', async () => {
    const onRetry = jest.fn();
    let calls = 0;
    const error = (await withRetry(
      async () => {
        calls += 1;
        return failing();
      },
      { maxAttempts: 5, baseDelayMs: 500, rng: () => 1, onRetry, deadlineAt: Date.now() + 1000 },
    ).catch((e: Error) => e)) as RetryExhaustedError;
    expect(calls).toBe(2);
    expect(error.context.attempts).toBe(2);
    expect(error.message).toContain('after 2 attempts');
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('reports the attempt reached, not the budget it was given', async () => {
    const error = (await withRetry(failing, {
      maxAttempts: 100,
      baseDelayMs: 0,
      rng: () => 1,
      deadlineAt: Date.now() - 1,
    }).catch((e: Error) => e)) as RetryExhaustedError;
    expect(error.context.attempts).not.toBe(100);
    expect(error.context.attempts).toBe(1);
  });

  it('throws a non-retryable error itself, inventing no attempt count', async () => {
    const permanent = Object.assign(new Error('nope'), { name: 'ValidationException' });
    const error = await withRetry(
      async () => {
        throw permanent;
      },
      { maxAttempts: 3, baseDelayMs: 0, deadlineAt: Date.now() - 1 },
    ).catch((e: Error) => e);
    expect(error).toBe(permanent);
    expect(error).not.toBeInstanceOf(RetryExhaustedError);
  });

  it('leaves the schedule and the count exactly as they are without a deadline', async () => {
    const onRetry = jest.fn();
    const failure = retryable();
    let calls = 0;
    const error = (await withRetry(
      async () => {
        calls += 1;
        throw failure;
      },
      { maxAttempts: 3, baseDelayMs: 10, rng: () => 1, onRetry },
    ).catch((e: Error) => e)) as RetryExhaustedError;
    expect(calls).toBe(3);
    expect(onRetry.mock.calls.map(([info]) => info)).toEqual([
      { attempt: 1, delayMs: 10, error: failure },
      { attempt: 2, delayMs: 20, error: failure },
    ]);
    expect(error.context.attempts).toBe(3);
    expect(error.message).toContain('after 3 attempts');
  });
});
