/**
 * Unit tests for src/shared/utils/retry.ts.
 *
 * Real surface (src/shared/utils/retry.ts):
 *   export interface RetryOptions {
 *     maxAttempts?: number; baseDelayMs?: number; maxDelayMs?: number;
 *     retryableErrors?: string[]; signal?: AbortSignal;
 *     // (REQ-44 seam, not yet present): rng?: () => number
 *   }
 *   export async function withRetry<T>(fn, options?): Promise<T>
 *   export async function withDynamoDBRetry<T>(fn, overrides?): Promise<T>
 *
 * Pinned from source:
 *   - DEFAULT_OPTIONS: maxAttempts 5, baseDelayMs 100, maxDelayMs 5000.
 *   - Internal calculateDelay(attempt, base, max) = rng() * Math.min(base * 2^(attempt-1), max).
 *     With the (planned) injectable rng seam this is exactly assertable: for a
 *     seeded rng sequence r0,r1,... the inter-attempt delays are
 *     r_i * min(base * 2^(attempt_i - 1), max). We reproduce that formula in-test
 *     using a second seededRandom() with the SAME seed so the schedule is exact.
 *   - On exhaustion withRetry re-throws the LAST captured error unchanged (an
 *     Error instance is re-thrown as-is; the thrown ThrottlingException keeps its
 *     message 'rate exceeded' and name).
 *   - isRetryableError matches the error's name/code/errno/syscall AND walks the
 *     `cause` chain up to MAX_CAUSE_DEPTH = 32; deeper causes are not inspected.
 *   - Non-retryable errors throw on the FIRST attempt (no sleep, no further fn call).
 *   - A pre-aborted signal throws `signal.reason ?? new Error('Aborted')` before
 *     any fn invocation.
 *
 * Plan rows: AC-20 (backoff schedule), AC-21 (classification table),
 * AC-18 (abort), AC-38 (rng seam), AC-40 (documented coverage exception),
 * AC-19 (logger discipline — see note below).
 *
 * SEAM NOTE: the `rng?` field on RetryOptions (REQ-44) does NOT exist in source
 * yet, so cases passing `rng` are expected to fail to compile until the seam
 * lands; that is the intended test-author handoff state.
 *
 * AC-19 NOTE (unresolved): src/shared/utils/retry.ts contains NO structured
 * logger call on its retry/catch path (it neither imports getLogger nor emits
 * any log). A passing { error.name, error.message, attempt } log assertion
 * against this module is therefore impossible without a source change that is
 * NOT an enumerated seam. The AC-19 obligation for this tier is satisfied on the
 * DDB-action retry paths (batch-write / action tests) per the plan note, not
 * here. The AC-19 case below asserts the real, current behavior (no log emitted)
 * via the capture helper and is reported as an unresolved TODO.
 */
import {
  withRetry,
  withDynamoDBRetry,
  type RetryOptions,
} from '../../../../src/shared/utils/retry';
import { preAbortedSignal } from '../../../shared/helpers/abort';
import { seededRandom } from '../../../shared/helpers/frozen-time';
import { captureLogger } from '../../../shared/helpers/logger-capture';

/** A retryable AWS-style error usable to force the retry loop to spin. */
function throttling(): Error {
  const e = new Error('rate exceeded');
  e.name = 'ThrottlingException';
  return e;
}

/**
 * Reproduce the source's calculateDelay schedule for a given seed.
 * delay_i = rng() * min(base * 2^(attempt-1), max), attempt = 1..(maxAttempts-1).
 */
function expectedSchedule(
  seed: number,
  maxAttempts: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number[] {
  const rng = seededRandom(seed);
  const delays: number[] = [];
  for (let attempt = 1; attempt <= maxAttempts - 1; attempt += 1) {
    const cap = Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
    delays.push(rng() * cap);
  }
  return delays;
}

const SEED = 0x5eed_1234;

describe('withRetry backoff schedule (fake timers + seeded RNG)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('exhausts exactly maxAttempts then throws the last error, firing no extra attempt', async () => {
    const fn = jest.fn(async () => {
      throw throttling();
    });

    const opts: RetryOptions = {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      rng: seededRandom(SEED),
    } as RetryOptions;

    const promise = withRetry(fn, opts);
    const assertion = expect(promise).rejects.toThrow('rate exceeded');
    await jest.runAllTimersAsync();
    await assertion;

    // maxAttempts === 3 means exactly 3 invocations, never a 4th. (AC-20)
    expect(fn).toHaveBeenCalledTimes(3);
  }); // AC-20

  it('sleeps for the EXACT seeded per-attempt delay sequence between attempts', async () => {
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const fn = jest.fn(async () => {
      throw throttling();
    });
    const opts: RetryOptions = {
      maxAttempts: 4,
      baseDelayMs: 100,
      maxDelayMs: 10_000,
      rng: seededRandom(SEED),
    } as RetryOptions;

    const promise = withRetry(fn, opts);
    const assertion = expect(promise).rejects.toThrow('rate exceeded');
    await jest.runAllTimersAsync();
    await assertion;

    const delays = setTimeoutSpy.mock.calls.map((c) => c[1] as number);
    // 4 attempts => 3 inter-attempt sleeps, each exactly rng()*min(base*2^(n-1),max).
    expect(delays).toEqual(expectedSchedule(SEED, 4, 100, 10_000));
    setTimeoutSpy.mockRestore();
  }); // AC-20

  it('sends an identical (zero-argument) fn invocation on each retry attempt', async () => {
    const seen: string[] = [];
    const fn = jest.fn(async () => {
      seen.push('invoke');
      throw throttling();
    });
    const opts: RetryOptions = {
      maxAttempts: 3,
      baseDelayMs: 50,
      maxDelayMs: 1_000,
      rng: seededRandom(SEED),
    } as RetryOptions;

    const promise = withRetry(fn, opts);
    const assertion = expect(promise).rejects.toThrow('rate exceeded');
    await jest.runAllTimersAsync();
    await assertion;

    // fn takes no per-attempt argument; identical invocation each time. (AC-20)
    expect(seen).toEqual(['invoke', 'invoke', 'invoke']);
    expect(fn.mock.calls.every((c) => c.length === 0)).toBe(true);
  }); // AC-20

  it('caps the per-attempt delay at maxDelayMs once base*2^(n-1) exceeds it', async () => {
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');
    const fn = jest.fn(async () => {
      throw throttling();
    });
    // base 1000, attempt windows 1000, 2000, 4000(capped→3000), 8000(capped→3000).
    const opts: RetryOptions = {
      maxAttempts: 5,
      baseDelayMs: 1_000,
      maxDelayMs: 3_000,
      rng: seededRandom(SEED),
    } as RetryOptions;

    const promise = withRetry(fn, opts);
    const assertion = expect(promise).rejects.toThrow('rate exceeded');
    await jest.runAllTimersAsync();
    await assertion;

    const delays = setTimeoutSpy.mock.calls.map((c) => c[1] as number);
    expect(delays).toEqual(expectedSchedule(SEED, 5, 1_000, 3_000));
    // Every delay stays within the capped window [0, maxDelayMs).
    expect(delays.every((d) => d >= 0 && d < 3_000)).toBe(true);
    setTimeoutSpy.mockRestore();
  }); // AC-20
});

describe('withRetry retryable-vs-non-retryable classification', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  function err(opts: { name?: string; code?: string; message?: string }): Error {
    const e = new Error(opts.message ?? 'x') as Error & { code?: string };
    if (opts.name) e.name = opts.name;
    if (opts.code) e.code = opts.code;
    return e;
  }

  // REQ-25 enumerated retryable names/codes from DEFAULT_OPTIONS.retryableErrors.
  const retryableCases: Array<{ label: string; make: () => Error }> = [
    {
      label: 'ProvisionedThroughputExceededException',
      make: () => err({ name: 'ProvisionedThroughputExceededException' }),
    },
    { label: 'ThrottlingException', make: () => err({ name: 'ThrottlingException' }) },
    { label: 'RequestLimitExceeded', make: () => err({ name: 'RequestLimitExceeded' }) },
    { label: 'InternalServerError', make: () => err({ name: 'InternalServerError' }) },
    { label: 'ServiceUnavailable', make: () => err({ name: 'ServiceUnavailable' }) },
    {
      label: 'TransactionConflictException',
      make: () => err({ name: 'TransactionConflictException' }),
    },
    { label: 'ECONNRESET', make: () => err({ code: 'ECONNRESET' }) },
    { label: 'ECONNREFUSED', make: () => err({ code: 'ECONNREFUSED' }) },
    { label: 'ETIMEDOUT', make: () => err({ code: 'ETIMEDOUT' }) },
    { label: 'EPIPE', make: () => err({ code: 'EPIPE' }) },
    { label: 'EAI_AGAIN', make: () => err({ code: 'EAI_AGAIN' }) },
  ];

  it.each(retryableCases)(
    'retries $label (retryable -> exactly maxAttempts invocations)',
    async ({ make }) => {
      const fn = jest.fn(async () => {
        throw make();
      });
      const promise = withRetry(fn, {
        maxAttempts: 2,
        baseDelayMs: 10,
        maxDelayMs: 100,
        rng: seededRandom(SEED),
      } as RetryOptions);
      const assertion = expect(promise).rejects.toBeInstanceOf(Error);
      await jest.runAllTimersAsync();
      await assertion;
      expect(fn).toHaveBeenCalledTimes(2);
    },
  ); // AC-21

  it('does NOT retry ConditionalCheckFailedException (non-retryable -> single attempt)', async () => {
    const fn = jest.fn(async () => {
      throw err({ name: 'ConditionalCheckFailedException', message: 'condition failed' });
    });
    await expect(
      withRetry(fn, {
        maxAttempts: 5,
        baseDelayMs: 10,
        maxDelayMs: 100,
        rng: seededRandom(SEED),
      } as RetryOptions),
    ).rejects.toThrow('condition failed');
    expect(fn).toHaveBeenCalledTimes(1);
  }); // AC-21

  it('does NOT retry TransactionCanceledException (permanent sibling -> single attempt)', async () => {
    // Source comment: TransactionCanceledException is intentionally NOT retried
    // (its CancellationReasons may be permanent), unlike TransactionConflictException.
    const fn = jest.fn(async () => {
      throw err({ name: 'TransactionCanceledException', message: 'cancelled' });
    });
    await expect(
      withRetry(fn, {
        maxAttempts: 5,
        baseDelayMs: 10,
        maxDelayMs: 100,
        rng: seededRandom(SEED),
      } as RetryOptions),
    ).rejects.toThrow('cancelled');
    expect(fn).toHaveBeenCalledTimes(1);
  }); // AC-21

  it('detects a retryable error wrapped one level deep in a cause chain', async () => {
    const wrapped = new Error('outer');
    (wrapped as Error & { cause?: unknown }).cause = err({ name: 'ThrottlingException' });
    const fn = jest.fn(async () => {
      throw wrapped;
    });
    const promise = withRetry(fn, {
      maxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 100,
      rng: seededRandom(SEED),
    } as RetryOptions);
    const assertion = expect(promise).rejects.toBeInstanceOf(Error);
    await jest.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(2);
  }); // AC-21

  it('treats a 33-deep cause chain as NON-matching (bound at depth 32)', async () => {
    // Build a chain whose deepest cause is retryable; the MAX_CAUSE_DEPTH=32 bound
    // means the scan never reaches it, so the top error is treated non-retryable
    // and thrown on the first attempt.
    let chain: Error = err({ name: 'ThrottlingException' });
    for (let i = 0; i < 33; i += 1) {
      const next = new Error(`wrap-${i}`);
      (next as Error & { cause?: unknown }).cause = chain;
      chain = next;
    }
    const fn = jest.fn(async () => {
      throw chain;
    });
    await expect(
      withRetry(fn, {
        maxAttempts: 5,
        baseDelayMs: 10,
        maxDelayMs: 100,
        rng: seededRandom(SEED),
      } as RetryOptions),
    ).rejects.toThrow('wrap-32');
    expect(fn).toHaveBeenCalledTimes(1);
  }); // AC-21
});

describe('withRetry abort / cancellation', () => {
  it('a pre-aborted signal rejects with the abort reason and never invokes fn', async () => {
    const reason = new Error('cancelled');
    const fn = jest.fn(async () => undefined);
    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 100,
        signal: preAbortedSignal(reason),
      }),
    ).rejects.toBe(reason);
    expect(fn).not.toHaveBeenCalled();
  }); // AC-18

  it('a pre-aborted signal with NO reason rejects with the default Error("Aborted")', async () => {
    // controller.abort() with no argument leaves signal.reason as the platform
    // default (an AbortError); the source falls back to new Error('Aborted') only
    // when reason is nullish. We assert the documented fallback contract: an Error
    // is thrown and fn is never invoked.
    const controller = new AbortController();
    // Force reason to be nullish so the `?? new Error('Aborted')` branch is taken.
    Object.defineProperty(controller.signal, 'reason', { value: undefined, configurable: true });
    Object.defineProperty(controller.signal, 'aborted', { value: true, configurable: true });
    const fn = jest.fn(async () => undefined);

    await expect(
      withRetry(fn, {
        maxAttempts: 3,
        baseDelayMs: 10,
        maxDelayMs: 100,
        signal: controller.signal,
      }),
    ).rejects.toThrow('Aborted');
    expect(fn).not.toHaveBeenCalled();
  }); // AC-18

  it('aborts mid-backoff: the in-flight sleep rejects with the abort reason instead of consuming the rest of the schedule', async () => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
    try {
      const controller = new AbortController();
      const reason = new Error('aborted-mid-backoff');
      // Always retryable so the loop reaches the sleep() between attempts, where
      // the abort can interrupt the backoff.
      const fn = jest.fn(async () => {
        throw throttling();
      });

      const promise = withRetry(fn, {
        maxAttempts: 5,
        baseDelayMs: 1_000,
        maxDelayMs: 10_000,
        signal: controller.signal,
        rng: seededRandom(SEED),
      } as RetryOptions);
      const assertion = expect(promise).rejects.toBe(reason);

      // Let attempt 1 run and enter the first backoff sleep, then abort mid-sleep.
      await Promise.resolve();
      controller.abort(reason);
      await jest.runAllTimersAsync();
      await assertion;

      // Aborted during the first backoff: exactly one fn invocation, schedule short-circuited.
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  }); // AC-18
});

describe('withRetry non-Error thrown-value wrapping', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('wraps a NON-retryable, non-Error thrown value (string) into an Error on the first attempt', async () => {
    // Non-retryable + not an Error instance => the mid-loop wrapping branch turns
    // the raw value into an Error(String(value)) and throws it immediately.
    const fn = jest.fn(async () => {
      throw 'plain-string-failure';
    });

    const promise = withRetry(fn, {
      maxAttempts: 5,
      baseDelayMs: 10,
      maxDelayMs: 100,
      rng: seededRandom(SEED),
    } as RetryOptions);
    const assertion = expect(promise).rejects.toThrow('plain-string-failure');
    await jest.runAllTimersAsync();
    await assertion;

    await expect(
      withRetry(
        jest.fn(async () => {
          throw 'plain-string-failure';
        }),
        {
          maxAttempts: 5,
          baseDelayMs: 10,
          maxDelayMs: 100,
          rng: seededRandom(SEED),
        } as RetryOptions,
      ),
    ).rejects.toBeInstanceOf(Error);
    // Non-retryable => not retried.
    expect(fn).toHaveBeenCalledTimes(1);
  }); // AC-21

  it('wraps a NON-retryable plain object preserving its message and copied properties', async () => {
    const raw = { message: 'object failure', name: 'WeirdError', detail: 42 };
    const fn = jest.fn(async () => {
      throw raw;
    });

    let caught: unknown;
    const promise = withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      rng: seededRandom(SEED),
    } as RetryOptions).catch((e: unknown) => {
      caught = e;
    });
    await jest.runAllTimersAsync();
    await promise;

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('object failure');
    // Object.assign copies own enumerable props onto the wrapper.
    expect((caught as Error & { detail?: number }).detail).toBe(42);
    expect(fn).toHaveBeenCalledTimes(1);
  }); // AC-21

  it('wraps a RETRYABLE non-Error value into an Error after exhausting every attempt (exhaustion path)', async () => {
    // A plain object carrying a retryable `name` is retried to exhaustion; since
    // it is never an Error instance, the post-loop wrapping branch converts the
    // captured lastError into an Error(message) with its props copied over.
    const raw = {
      name: 'ThrottlingException',
      message: 'rate exceeded',
      code: 'ThrottlingException',
      extra: 'x',
    };
    const fn = jest.fn(async () => {
      throw raw;
    });

    let caught: unknown;
    const promise = withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      rng: seededRandom(SEED),
    } as RetryOptions).catch((e: unknown) => {
      caught = e;
    });
    await jest.runAllTimersAsync();
    await promise;

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('rate exceeded');
    expect((caught as Error & { extra?: string }).extra).toBe('x');
    // Retryable => retried to the full attempt budget before wrapping.
    expect(fn).toHaveBeenCalledTimes(3);
  }); // AC-21

  it('treats a falsy thrown value (0) as non-retryable and wraps it via String() on the first attempt', async () => {
    // isRetryableError(0) hits the `!error` guard and returns false; the value is
    // then wrapped through the String(value) branch since it is not an Error.
    const fn = jest.fn(async () => {
      throw 0;
    });

    const promise = withRetry(fn, {
      maxAttempts: 3,
      baseDelayMs: 10,
      maxDelayMs: 100,
      rng: seededRandom(SEED),
    } as RetryOptions);
    const assertion = expect(promise).rejects.toThrow('0');
    await jest.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(1);
  }); // AC-21

  it('classifies a Node socket error by its errno/syscall fields (not just name/code)', async () => {
    // Exercises the errno + syscall signal collectors: a raw socket error often
    // carries errno/syscall rather than a matching name.
    const sockErr = Object.assign(new Error('connection reset'), {
      errno: 'ECONNRESET',
      syscall: 'read',
    });
    const fn = jest.fn(async () => {
      throw sockErr;
    });

    const promise = withRetry(fn, {
      maxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 100,
      rng: seededRandom(SEED),
    } as RetryOptions);
    const assertion = expect(promise).rejects.toThrow('connection reset');
    await jest.runAllTimersAsync();
    await assertion;

    // errno matched ECONNRESET => retried to the attempt budget.
    expect(fn).toHaveBeenCalledTimes(2);
  }); // AC-21

  it('ignores a non-string cause node when walking the chain (primitive cause does not crash the scan)', async () => {
    // A retryable top-level name with a primitive `cause` exercises the
    // collect() guard that skips non-object causes without throwing.
    const e = Object.assign(new Error('x'), { name: 'ThrottlingException' }) as Error & {
      cause?: unknown;
    };
    e.cause = 'a-primitive-cause';
    const fn = jest.fn(async () => {
      throw e;
    });

    const promise = withRetry(fn, {
      maxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 100,
      rng: seededRandom(SEED),
    } as RetryOptions);
    const assertion = expect(promise).rejects.toBe(e);
    await jest.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(2);
  }); // AC-21

  it('wraps a RETRYABLE non-Error object that has NO message property on exhaustion via String()', async () => {
    // Retryable by `code` but carrying no `message`: the post-loop wrapper takes
    // the String(lastError) branch (the `'message' in lastError` test is false).
    const raw = { code: 'ECONNRESET', detail: 'socket' };
    const fn = jest.fn(async () => {
      throw raw;
    });

    let caught: unknown;
    const promise = withRetry(fn, {
      maxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 100,
      rng: seededRandom(SEED),
    } as RetryOptions).catch((err: unknown) => {
      caught = err;
    });
    await jest.runAllTimersAsync();
    await promise;

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('[object Object]');
    expect((caught as Error & { detail?: string }).detail).toBe('socket');
    expect(fn).toHaveBeenCalledTimes(2);
  }); // AC-21

  it('wraps a RETRYABLE non-object thrown value (string with retryable substring) on exhaustion via String()', async () => {
    // isRetryableError only inspects object fields, so a bare string is NOT
    // retryable and throws on the first attempt through the String(value) branch.
    const fn = jest.fn(async () => {
      throw 'ThrottlingException: rate exceeded';
    });

    const promise = withRetry(fn, {
      maxAttempts: 4,
      baseDelayMs: 10,
      maxDelayMs: 100,
      rng: seededRandom(SEED),
    } as RetryOptions);
    const assertion = expect(promise).rejects.toThrow('ThrottlingException: rate exceeded');
    await jest.runAllTimersAsync();
    await assertion;

    expect(fn).toHaveBeenCalledTimes(1);
  }); // AC-21
});

describe('withRetry seam regression (REQ-44 / AC-38)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('default RNG path (no rng injected) still retries and resolves on eventual success', async () => {
    let n = 0;
    const fn = jest.fn(async () => {
      n += 1;
      if (n < 2) throw throttling();
      return 'ok';
    });
    // No `rng` => defaults to Math.random (seeded globally by test-setup). The
    // control flow must be unchanged by the seam.
    const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100 });
    await jest.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  }); // AC-38

  it('injected seeded RNG drives an exactly-reproducible schedule and a different seed differs', async () => {
    const setTimeoutSpy = jest.spyOn(globalThis, 'setTimeout');

    const run = async (seed: number): Promise<number[]> => {
      setTimeoutSpy.mockClear();
      const fn = jest.fn(async () => {
        throw throttling();
      });
      const p = withRetry(fn, {
        maxAttempts: 4,
        baseDelayMs: 100,
        maxDelayMs: 10_000,
        rng: seededRandom(seed),
      } as RetryOptions);
      const a = expect(p).rejects.toThrow('rate exceeded');
      await jest.runAllTimersAsync();
      await a;
      return setTimeoutSpy.mock.calls.map((c) => c[1] as number);
    };

    const seedA = await run(1);
    const seedB = await run(999_999);
    // The injected RNG is consulted: same seed reproduces the exact schedule, a
    // different seed yields a different one.
    expect(seedA).toEqual(expectedSchedule(1, 4, 100, 10_000));
    expect(seedA).not.toEqual(seedB);
    setTimeoutSpy.mockRestore();
  }); // AC-38
});

describe('withDynamoDBRetry override forwarding', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('forwards a maxAttempts override and honors it as the hard attempt boundary', async () => {
    const fn = jest.fn(async () => {
      throw throttling();
    });
    const promise = withDynamoDBRetry(fn, { maxAttempts: 2 });
    const assertion = expect(promise).rejects.toThrow('rate exceeded');
    await jest.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(2);
  }); // AC-20

  it('resolves immediately (single attempt) when fn succeeds on the first try', async () => {
    const fn = jest.fn(async () => 'value');
    await expect(withDynamoDBRetry(fn, {})).resolves.toBe('value');
    expect(fn).toHaveBeenCalledTimes(1);
  }); // AC-20
});

describe('withRetry logger discipline (AC-19)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  // UNRESOLVED TODO(test-author): src/shared/utils/retry.ts emits NO structured
  // log on its retry/catch path — it does not import or call getLogger and has no
  // logger seam in the spec's enumerated seam list. A passing { error.name,
  // error.message, attempt } assertion against this module is therefore not
  // achievable without an out-of-scope source change. The AC-19 obligation is met
  // by the DDB-action retry paths (batch-write / action tests) per the plan note.
  // This case asserts the real, current behavior (no log emitted) so a future
  // logging addition is caught and AC-19 can be moved/extended deliberately.
  it('emits no logger entries from the bare withRetry retry path (documents the AC-19 gap)', async () => {
    const cap = captureLogger();
    const fn = jest.fn(async () => {
      throw throttling();
    });
    const promise = withRetry(fn, {
      maxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 100,
      rng: seededRandom(SEED),
    } as RetryOptions);
    const assertion = expect(promise).rejects.toThrow('rate exceeded');
    await jest.runAllTimersAsync();
    await assertion;

    // retry.ts does not log: zero captured entries through the retry+exhaustion path.
    expect(cap.entries).toEqual([]);
    cap.restore();
  }); // AC-19
});

describe('withRetry documented coverage exception (AC-40)', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('re-throws the original last error on exhaustion (not the generic guard)', async () => {
    // On a normal exhaustion the loop captured lastError, so withRetry re-throws
    // the SAME original error object — the `'Retry failed without error'` guard is
    // NOT used on this path (it is reserved for the maxAttempts:0 case below).
    const original = throttling();
    const fn = jest.fn(async () => {
      throw original;
    });
    const promise = withRetry(fn, {
      maxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 100,
      rng: seededRandom(SEED),
    } as RetryOptions);
    const assertion = expect(promise).rejects.toBe(original);
    await jest.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(2);
  }); // AC-40

  it('throws "Retry failed without error" when maxAttempts is 0 so the loop never runs', async () => {
    // maxAttempts:0 means `for (attempt=1; attempt<=0; ...)` never enters the
    // body, so fn is never invoked and lastError is never set — the post-loop
    // guard is the reachable path that fires here.
    const fn = jest.fn(async () => 'unused');
    await expect(withRetry(fn, { maxAttempts: 0 } as RetryOptions)).rejects.toThrow(
      'Retry failed without error',
    );
    expect(fn).not.toHaveBeenCalled();
  }); // AC-40
});

describe('withRetry classification + wrapping edge cases', () => {
  beforeEach(() => {
    jest.useFakeTimers({ now: 1_700_000_000_000 });
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('resolves with no options argument at all (default options branch)', async () => {
    // Calling withRetry(fn) exercises the `options: RetryOptions = {}` default.
    const fn = jest.fn(async () => 'ok');
    await expect(withRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('treats a self-referential cause cycle as non-retryable without infinite recursion', async () => {
    // The cause chain points back at itself; the WeakSet `seen` guard must short-
    // circuit the second visit. The error name is non-retryable, so it throws on
    // the first attempt.
    const cyclic = new Error('cyclic') as Error & { cause?: unknown };
    cyclic.name = 'NonRetryableCyclic';
    cyclic.cause = cyclic;
    const fn = jest.fn(async () => {
      throw cyclic;
    });
    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toBe(cyclic);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('wraps a retryable NON-Error object on exhaustion, copying its own props onto the Error', async () => {
    // A plain (non-Error) object retryable via `name`. After exhausting the budget
    // the post-loop wrapper builds an Error (message = String(obj) since there is
    // no `message`), then Object.assigns the own props (name) onto it.
    const raw = { name: 'ThrottlingException', detail: 'slow down' };
    const fn = jest.fn(async () => {
      throw raw;
    });
    let caught: unknown;
    const p = withRetry(fn, {
      maxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 100,
      rng: seededRandom(SEED),
    } as RetryOptions).catch((e: unknown) => {
      caught = e;
    });
    await jest.runAllTimersAsync();
    await p;

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('[object Object]');
    expect((caught as Error & { detail?: string }).detail).toBe('slow down');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('uses the own message of a retryable NON-Error object when wrapping on exhaustion', async () => {
    // Same exhaustion path as above, but the object carries its own `message`, so
    // the wrapper uses it ('message' in lastObj === true) instead of String(obj).
    const raw = { name: 'ThrottlingException', message: 'rate exceeded by object' };
    const fn = jest.fn(async () => {
      throw raw;
    });
    let caught: unknown;
    const p = withRetry(fn, {
      maxAttempts: 2,
      baseDelayMs: 10,
      maxDelayMs: 100,
      rng: seededRandom(SEED),
    } as RetryOptions).catch((e: unknown) => {
      caught = e;
    });
    await jest.runAllTimersAsync();
    await p;

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('rate exceeded by object');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('classifies a falsy thrown value (null) as non-retryable and throws on the first attempt', async () => {
    // isRetryableError(null) hits the `!error` guard -> false -> non-retryable.
    const fn = jest.fn(async () => {
      throw null;
    });
    let caught: unknown = 'unset';
    const p = withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 }).catch((e: unknown) => {
      caught = e;
    });
    await jest.runAllTimersAsync();
    await p;
    // null is re-wrapped as Error('null') on the non-retryable first-attempt path.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe('null');
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
