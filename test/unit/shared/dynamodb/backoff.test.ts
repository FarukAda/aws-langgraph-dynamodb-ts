import { fullJitter, nextBackoffDelay, sleep } from '../../../../src/shared/dynamodb/backoff';
import { AbortError } from '../../../../src/shared/errors/errors';

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
    controller.abort(new AbortError());
    await expect(sleep(1000, controller.signal)).rejects.toBeInstanceOf(AbortError);
  });

  it('falls back to a fresh AbortError when an already-aborted signal has no reason', async () => {
    const signal = { aborted: true, reason: undefined } as unknown as AbortSignal;
    await expect(sleep(1000, signal)).rejects.toBeInstanceOf(AbortError);
  });

  it('rejects with the abort reason when aborted while pending', async () => {
    const controller = new AbortController();
    const reason = new AbortError('cancelled mid-flight');
    const pending = sleep(10000, controller.signal);
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });

  it('falls back to a fresh AbortError when an aborted signal exposes no reason', async () => {
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
    await expect(pending).rejects.toBeInstanceOf(AbortError);
  });

  it('ignores a repeated abort after it has already settled', async () => {
    const listeners: Array<() => void> = [];
    const signal = {
      aborted: false,
      reason: new AbortError('first'),
      addEventListener: (_event: string, listener: () => void) => {
        listeners.push(listener);
      },
      removeEventListener: () => {},
    } as unknown as AbortSignal;
    const pending = sleep(10000, signal);
    listeners.forEach((listener) => listener());
    listeners.forEach((listener) => listener());
    await expect(pending).rejects.toBeInstanceOf(AbortError);
  });

  it('ignores the timer firing after the signal already aborted', async () => {
    let capturedListener: (() => void) | undefined;
    let removed = false;
    const signal = {
      aborted: false,
      reason: new AbortError('aborted-first'),
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
      await expect(pending).rejects.toBeInstanceOf(AbortError);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } finally {
      clearSpy.mockRestore();
    }
    expect(removed).toBe(false);
  });
});
