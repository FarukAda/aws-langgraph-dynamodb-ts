import {
  MAX_LOGGED_VALUE_CHARS,
  MAX_WRITE_LIFETIME_MS,
  MESSAGE_APPEND_RETRY_MAX_ATTEMPTS,
} from '../../../../src/shared/constants';
import { withRetry } from '../../../../src/shared/dynamodb/retry';
import { resolveRetryPolicy } from '../../../../src/shared/dynamodb/retry-policy';
import { truncateForLog } from '../../../../src/shared/logging/truncate';

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

/**
 * A policy long enough to outlive the deadline every token-carrying write
 * runs under is legal and stays legal; what it must not be is silent. The
 * budget is compared against `MAX_WRITE_LIFETIME_MS` rather than against the
 * ten-minute window itself, because that constant is the bound the writes
 * actually carry.
 */
describe('resolveRetryPolicy warns when a policy outlives the write deadline (DDB-03)', () => {
  it('stays silent for the defaults, which is what keeps the warning worth reading', () => {
    const logger = fakeLogger();
    resolveRetryPolicy(undefined, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  /**
   * 99 sleeps at the default delays: 6 300 ms while the exponential climbs,
   * then 93 caps of 5 000 ms. The number is asserted exactly because it is the
   * one a reader compares against the deadline.
   */
  it('warns once, naming the budget and the deadline it exceeds', () => {
    const logger = fakeLogger();
    resolveRetryPolicy({ maxAttempts: 100 }, logger);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('retry policy outlives'), {
      budgetMs: 471_300,
      maxWriteLifetimeMs: MAX_WRITE_LIFETIME_MS,
    });
  });

  /**
   * The formula, pinned. 64 sleeps sum to 296 300 ms — just inside the
   * deadline — while the reading a reader is most likely to assume,
   * `maxAttempts × maxDelayMs`, gives 325 000 ms and would warn here.
   */
  it('sums the schedule rather than multiplying attempts by the delay cap', () => {
    const logger = fakeLogger();
    resolveRetryPolicy({ maxAttempts: 65 }, logger);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  /**
   * A raised delay cap is the other way over, and the one a caller reaches
   * first: 18 attempts is the append path's own floor, and at a 60 s cap that
   * schedule alone runs to 522 300 ms.
   */
  it('counts a raised delay cap, not only a raised attempt count', () => {
    const logger = fakeLogger();
    resolveRetryPolicy({ maxAttempts: 18, maxDelayMs: 60_000 }, logger);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
      budgetMs: 522_300,
      maxWriteLifetimeMs: MAX_WRITE_LIFETIME_MS,
    });
  });

  it('leaves the resolved options themselves unchanged', () => {
    const resolved = resolveRetryPolicy({ maxAttempts: 100 }, fakeLogger());
    expect(resolved).toMatchObject({ maxAttempts: 100, baseDelayMs: 100, maxDelayMs: 5000 });
  });
});

describe('the attempt floor an adapter applies', () => {
  /**
   * The configuration a caller is most likely to reach, and the one the
   * warning used to miss entirely: raising only the delay cap leaves
   * `maxAttempts` at the default, so the caller's own policy looks harmless -
   * while the history append raises the count to its floor and keeps the
   * raised delays, producing a budget well past the deadline.
   */
  it('warns at the attempts the adapter will really make, not the ones the caller wrote', () => {
    const logger = fakeLogger();

    resolveRetryPolicy({ maxDelayMs: 60_000 }, logger);
    expect(logger.warn).not.toHaveBeenCalled();

    resolveRetryPolicy({ maxDelayMs: 60_000 }, logger, MESSAGE_APPEND_RETRY_MAX_ATTEMPTS);
    expect(logger.warn).toHaveBeenCalledWith(expect.any(String), {
      budgetMs: 522_300,
      maxWriteLifetimeMs: MAX_WRITE_LIFETIME_MS,
    });
  });

  it('leaves an adapter that honours the caller its own budget', () => {
    const logger = fakeLogger();

    resolveRetryPolicy(undefined, logger, MESSAGE_APPEND_RETRY_MAX_ATTEMPTS);

    expect(logger.warn).not.toHaveBeenCalled();
  });
});

/**
 * The retry line names the transient failure rather than repeating its text.
 * That name comes from the SDK, the transport or a caller's own collaborator
 * and nothing this package ran checked its length, and the line fires once per
 * attempt — so an unbounded name is paid for per retry.
 */
describe('the debug line a retry emits', () => {
  it('cuts the error name it quotes at the log cap', async () => {
    const name = 'T'.repeat(MAX_LOGGED_VALUE_CHARS * 4);
    const logger = fakeLogger();
    const options = resolveRetryPolicy({ maxAttempts: 2, baseDelayMs: 0 }, logger);
    let attempts = 0;

    await withRetry(async () => {
      attempts += 1;
      if (attempts === 1) {
        /** Retryable by its , so the line under test is the one that fires. */
        throw Object.assign(new Error('slow'), { name, code: 'ThrottlingException' });
      }
      return 'ok';
    }, options);

    expect(logger.debug).toHaveBeenCalledWith(
      'retrying after a transient error',
      expect.objectContaining({ error: truncateForLog(name) }),
    );
  });
});
