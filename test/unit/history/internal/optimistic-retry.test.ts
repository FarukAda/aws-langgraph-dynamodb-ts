import {
  isConditionalCheckFailed,
  withOptimisticRetry,
} from '../../../../src/history/internal/optimistic-retry';
import { ErrorCode } from '../../../../src/shared/errors/error-code';

const conflict = () =>
  Object.assign(new Error('race'), { name: 'ConditionalCheckFailedException' });

describe('withOptimisticRetry', () => {
  it('returns once the attempt succeeds', async () => {
    const attempt = jest.fn().mockResolvedValue(undefined);
    await withOptimisticRetry(attempt);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('retries on a conditional-check failure then succeeds', async () => {
    const attempt = jest.fn().mockRejectedValueOnce(conflict()).mockResolvedValueOnce(undefined);
    await withOptimisticRetry(attempt);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it('throws a CONDITION_CONFLICT error after exhausting attempts', async () => {
    const attempt = jest.fn().mockRejectedValue(conflict());
    try {
      await withOptimisticRetry(attempt, 3);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { code: ErrorCode }).code).toBe(ErrorCode.CONDITION_CONFLICT);
    }
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it('rethrows non-conflict errors immediately', async () => {
    const attempt = jest.fn().mockRejectedValue(new Error('boom'));
    await expect(withOptimisticRetry(attempt)).rejects.toThrow('boom');
    expect(attempt).toHaveBeenCalledTimes(1);
  });
});

describe('isConditionalCheckFailed', () => {
  it('detects the DynamoDB condition-failure error name', () => {
    expect(isConditionalCheckFailed(conflict())).toBe(true);
    expect(isConditionalCheckFailed(new Error('other'))).toBe(false);
  });
});
