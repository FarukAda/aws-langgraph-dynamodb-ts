import { withRetry } from '../../../../src/shared/dynamodb/retry';
import { resolveRetryPolicy } from '../../../../src/shared/dynamodb/retry-policy';

const fakeLogger = () => ({ debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() });

describe('resolveRetryPolicy (DDB-03, DDB-10)', () => {
  it('applies the documented defaults when no policy is given', () => {
    const resolved = resolveRetryPolicy(undefined, fakeLogger());
    expect(resolved).toMatchObject({ maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 5000 });
    expect(typeof resolved.onRetry).toBe('function');
  });

  it('honours every tunable the caller sets', () => {
    const resolved = resolveRetryPolicy(
      { maxAttempts: 8, baseDelayMs: 50, maxDelayMs: 2000 },
      fakeLogger(),
    );
    expect(resolved).toMatchObject({ maxAttempts: 8, baseDelayMs: 50, maxDelayMs: 2000 });
  });

  it('logs every retry at debug with the attempt, delay and error name', async () => {
    const logger = fakeLogger();
    const resolved = resolveRetryPolicy({ baseDelayMs: 1 }, logger);
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw Object.assign(new Error('slow'), { name: 'ThrottlingException' });
        return calls;
      },
      { ...resolved, rng: () => 1 },
    );
    expect(logger.debug).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('retrying'), {
      attempt: 1,
      delayMs: 1,
      error: 'ThrottlingException',
    });
  });
});
