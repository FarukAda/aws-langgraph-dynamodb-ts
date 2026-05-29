/**
 * Unit tests for src/history/utils/optimistic-retry.ts.
 *
 * Locks AC-22 / REQ-26: isConditionalCheckFailure boolean classification across
 * the bare-exception, all-conditional transaction, mixed-permanent, and
 * empty-reasons cases; and withOptimisticRetry retry-up-to-MAX then labelled
 * exhaustion throw.
 *
 * Pinned to the REAL source surface:
 *   export const MAX_OPTIMISTIC_RETRIES = 5;
 *   export function isConditionalCheckFailure(err: unknown): boolean;
 *   export function withOptimisticRetry<T>(label, fn: (attempt) => Promise<T>): Promise<T>;
 *
 * Behaviour pinned from source:
 *   - withOptimisticRetry loops `for (attempt = 0; attempt < MAX; attempt++)`,
 *     retries ONLY when isConditionalCheckFailure(err) && attempt < MAX-1,
 *     otherwise re-throws the original error immediately, and on exhaustion
 *     throws `${label} failed after ${MAX_OPTIMISTIC_RETRIES} optimistic-lock retries`.
 *   - isConditionalCheckFailure: bare ConditionalCheckFailedException -> true;
 *     TransactionCanceledException requires >=1 'ConditionalCheckFailed' AND no
 *     permanent (non-'None') sub-reason; empty CancellationReasons -> false.
 *
 * Determinism: NO real timers, NO Math.random. Retry count is observed via a
 * recorded call counter on the injected fn.
 *
 * The module exposes no cursor encode/decode API (the plan note mentioned one);
 * confirmed absent in source, so no round-trip test is written. (resolved gap)
 */
import {
  isConditionalCheckFailure,
  withOptimisticRetry,
  MAX_OPTIMISTIC_RETRIES,
} from '../../../../src/history/utils/optimistic-retry';

/** A bare ConditionalCheckFailedException-shaped error. */
function conditionalCheckError(): Error {
  const err = new Error('The conditional request failed');
  err.name = 'ConditionalCheckFailedException';
  return err;
}

/** A TransactionCanceledException with the given CancellationReasons codes. */
function transactionCanceled(codes: Array<string>): Error {
  const err = new Error('Transaction cancelled') as Error & {
    CancellationReasons?: Array<{ Code: string }>;
  };
  err.name = 'TransactionCanceledException';
  err.CancellationReasons = codes.map((Code) => ({ Code }));
  return err;
}

describe('optimistic-retry', () => {
  describe('isConditionalCheckFailure', () => {
    it('returns true for a bare ConditionalCheckFailedException', () => {
      expect(isConditionalCheckFailure(conditionalCheckError())).toBe(true);
    }); // AC-22

    it('returns true for a TransactionCanceledException whose reasons are all ConditionalCheckFailed', () => {
      const err = transactionCanceled(['ConditionalCheckFailed', 'ConditionalCheckFailed']);
      expect(isConditionalCheckFailure(err)).toBe(true);
    }); // AC-22

    it('returns true for a TransactionCanceledException mixing ConditionalCheckFailed and None reasons', () => {
      const err = transactionCanceled(['ConditionalCheckFailed', 'None']);
      expect(isConditionalCheckFailure(err)).toBe(true);
    }); // AC-22

    it('returns false for a TransactionCanceledException with a mixed permanent sub-reason', () => {
      const err = transactionCanceled(['ConditionalCheckFailed', 'ValidationError']);
      expect(isConditionalCheckFailure(err)).toBe(false);
    }); // AC-22

    it('returns false for a TransactionCanceledException whose only reason is None (no conditional failure seen)', () => {
      const err = transactionCanceled(['None', 'None']);
      expect(isConditionalCheckFailure(err)).toBe(false);
    }); // AC-22

    it('returns false for a TransactionCanceledException with empty CancellationReasons', () => {
      const err = transactionCanceled([]);
      expect(isConditionalCheckFailure(err)).toBe(false);
    }); // AC-22

    it('returns false for a TransactionCanceledException with no CancellationReasons array', () => {
      const err = new Error('Transaction cancelled');
      err.name = 'TransactionCanceledException';
      expect(isConditionalCheckFailure(err)).toBe(false);
    }); // AC-22

    it('returns false for an unrelated AWS error name', () => {
      const err = new Error('throughput exceeded');
      err.name = 'ProvisionedThroughputExceededException';
      expect(isConditionalCheckFailure(err)).toBe(false);
    }); // AC-22

    it('returns false for null and non-object inputs', () => {
      expect(isConditionalCheckFailure(null)).toBe(false);
      expect(isConditionalCheckFailure(undefined)).toBe(false);
      expect(isConditionalCheckFailure('ConditionalCheckFailedException')).toBe(false);
    }); // AC-22

    it('returns false for a truthy non-object whose own .name matches (kills typeof-object guard mutant)', () => {
      // A function is truthy and has a real `.name` property equal to the
      // exception name, but `typeof fn !== 'object'`. The non-object guard must
      // still reject it. Mutating `typeof err !== 'object'` to `false` would let
      // this through and wrongly return true.
      function ConditionalCheckFailedException(): void {}
      expect(ConditionalCheckFailedException.name).toBe('ConditionalCheckFailedException');
      expect(isConditionalCheckFailure(ConditionalCheckFailedException)).toBe(false);
    }); // AC-22

    it('returns false when CancellationReasons exist but the name is NOT TransactionCanceledException (kills name-check mutant)', () => {
      // Only TransactionCanceledException should be inspected for reasons. An
      // unrelated error carrying a CancellationReasons array with a conditional
      // failure must NOT be treated as retryable. Mutating the name comparison to
      // `true` would enter the reasons branch and wrongly return true.
      const err = new Error('some other error') as Error & {
        CancellationReasons?: Array<{ Code: string }>;
      };
      err.name = 'SomeOtherException';
      err.CancellationReasons = [{ Code: 'ConditionalCheckFailed' }];
      expect(isConditionalCheckFailure(err)).toBe(false);
    }); // AC-22

    it('uses optional chaining on each reason so a null reason element does not throw (kills r?.Code mutant)', () => {
      // A reasons array with a null element: optional chaining yields undefined for
      // that element (skipped) and the prior ConditionalCheckFailed still wins, so
      // the function RETURNS true rather than throwing. Mutating `r?.Code` to
      // `r.Code` would throw a TypeError on the null element.
      const err = new Error('Transaction cancelled') as Error & {
        CancellationReasons?: Array<{ Code: string } | null>;
      };
      err.name = 'TransactionCanceledException';
      err.CancellationReasons = [{ Code: 'ConditionalCheckFailed' }, null];
      let result: boolean | undefined;
      expect(() => {
        result = isConditionalCheckFailure(err);
      }).not.toThrow();
      expect(result).toBe(true);
    }); // AC-22
  });

  describe('withOptimisticRetry', () => {
    it('exposes MAX_OPTIMISTIC_RETRIES === 5 (the documented exhaustion bound)', () => {
      expect(MAX_OPTIMISTIC_RETRIES).toBe(5);
    }); // AC-22

    it('returns the value on first success without retrying, threading the attempt index', async () => {
      let calls = 0;
      const result = await withOptimisticRetry('write-meta', async (attempt) => {
        calls += 1;
        return `ok-${attempt}`;
      });
      expect(calls).toBe(1);
      expect(result).toBe('ok-0');
    }); // AC-22

    it('succeeds after N conditional-check collisions, calling fn exactly N+1 times', async () => {
      let calls = 0;
      const result = await withOptimisticRetry('write-meta', async () => {
        calls += 1;
        if (calls <= 2) {
          throw conditionalCheckError();
        }
        return 'won';
      });
      expect(calls).toBe(3);
      expect(result).toBe('won');
    }); // AC-22

    it('throws the labelled exhaustion error after MAX_OPTIMISTIC_RETRIES collisions', async () => {
      let calls = 0;
      await expect(
        withOptimisticRetry('write-meta', async () => {
          calls += 1;
          throw conditionalCheckError();
        }),
      ).rejects.toThrow(
        `write-meta failed after ${MAX_OPTIMISTIC_RETRIES} optimistic-lock retries`,
      );
      expect(calls).toBe(MAX_OPTIMISTIC_RETRIES);
    }); // AC-22

    it('rethrows a non-conditional error immediately without retrying', async () => {
      let calls = 0;
      const fatal = new Error('validation boom');
      fatal.name = 'ValidationException';
      await expect(
        withOptimisticRetry('write-meta', async () => {
          calls += 1;
          throw fatal;
        }),
      ).rejects.toBe(fatal);
      expect(calls).toBe(1);
    }); // AC-22
  });
});
