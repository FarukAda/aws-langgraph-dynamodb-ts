import { fullJitter, nextBackoffDelay, sleep } from '../../../../src/shared/dynamodb/retry';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { abortError } from '../../../../src/shared/errors/errors';

describe('nextBackoffDelay', () => {
  it('doubles up to the cap', () => {
    expect(nextBackoffDelay(100)).toBe(200);
    expect(nextBackoffDelay(4000, 5000)).toBe(5000);
  });
});

describe('fullJitter', () => {
  it('returns rng() * delay using the injected rng', () => {
    expect(fullJitter(1000, () => 0.5)).toBe(500);
  });

  it('defaults to Math.random, producing a value within [0, delay)', () => {
    const result = fullJitter(1000);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThan(1000);
  });
});

describe('sleep', () => {
  it('resolves after the delay', async () => {
    await expect(sleep(1)).resolves.toBeUndefined();
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort(abortError());
    await expect(sleep(1000, controller.signal)).rejects.toMatchObject({ code: ErrorCode.ABORTED });
  });

  it('falls back to a fresh ABORTED error when an already-aborted signal has no reason', async () => {
    const signal = { aborted: true, reason: undefined } as unknown as AbortSignal;
    await expect(sleep(1000, signal)).rejects.toMatchObject({ code: ErrorCode.ABORTED });
  });

  it('rejects with the abort reason when aborted while pending', async () => {
    const controller = new AbortController();
    const reason = abortError('cancelled mid-flight');
    const pending = sleep(10000, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('falls back to a fresh ABORTED error when an aborted signal exposes no reason', async () => {
    const listeners: Array<() => void> = [];
    const signal = {
      aborted: false,
      reason: undefined,
      addEventListener: (_event: string, listener: () => void) => {
        listeners.push(listener);
      },
      removeEventListener: () => {},
    } as unknown as AbortSignal;
    const pending = sleep(10000, signal);
    listeners.forEach((listener) => listener());
    await expect(pending).rejects.toMatchObject({ code: ErrorCode.ABORTED });
  });

  it('ignores a repeated abort after it has already settled', async () => {
    const listeners: Array<() => void> = [];
    const signal = {
      aborted: false,
      reason: abortError('first'),
      addEventListener: (_event: string, listener: () => void) => {
        listeners.push(listener);
      },
      removeEventListener: () => {},
    } as unknown as AbortSignal;
    const pending = sleep(10000, signal);
    listeners.forEach((listener) => listener());
    listeners.forEach((listener) => listener());
    await expect(pending).rejects.toMatchObject({ code: ErrorCode.ABORTED });
  });

  it('ignores the timer firing after the signal already aborted', async () => {
    let capturedListener: (() => void) | undefined;
    let removed = false;
    const signal = {
      aborted: false,
      reason: abortError('aborted-first'),
      addEventListener: (_event: string, listener: () => void) => {
        capturedListener = listener;
      },
      removeEventListener: () => {
        removed = true;
      },
    } as unknown as AbortSignal;
    const clearSpy = jest.spyOn(global, 'clearTimeout').mockImplementation(() => undefined);
    try {
      const pending = sleep(0, signal);
      capturedListener?.();
      await expect(pending).rejects.toMatchObject({ code: ErrorCode.ABORTED });
      await new Promise((resolve) => setTimeout(resolve, 25));
    } finally {
      clearSpy.mockRestore();
    }
    expect(removed).toBe(false);
  });
});

/**
 * The listener is attached before the timer is armed. Armed first, a throwing
 * `addEventListener` rejected the wait but left the timer behind, and that
 * timer later called `removeEventListener` outside any promise: an uncaught
 * exception.
 */
describe('sleep leaves nothing pending when attaching the listener fails', () => {
  afterEach(() => jest.useRealTimers());

  it('rejects with the error and arms no timer', async () => {
    jest.useFakeTimers();
    const signal = {
      aborted: false,
      addEventListener: () => {
        throw new Error('listener refused');
      },
      removeEventListener: () => {
        throw new Error('removed a listener that was never added');
      },
    } as unknown as AbortSignal;
    await expect(sleep(1000, signal)).rejects.toThrow('listener refused');
    expect(jest.getTimerCount()).toBe(0);
    expect(() => jest.advanceTimersByTime(2000)).not.toThrow();
  });

  it('arms no timer when the listener runs while it is being attached', async () => {
    jest.useFakeTimers();
    const signal = {
      aborted: false,
      reason: abortError('aborted on attach'),
      addEventListener: (_event: string, listener: () => void) => listener(),
      removeEventListener: () => {},
    } as unknown as AbortSignal;
    await expect(sleep(1000, signal)).rejects.toMatchObject({ code: ErrorCode.ABORTED });
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('sleep abort normalisation (DDB-05)', () => {
  it('rejects with the library ABORTED error while pending, keeping the raw reason as cause', async () => {
    const controller = new AbortController();
    const pending = sleep(10_000, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: ErrorCode.ABORTED,
      name: 'DynamoDBLangGraphError',
      cause: expect.objectContaining({ name: 'AbortError' }),
    });
  });
});
