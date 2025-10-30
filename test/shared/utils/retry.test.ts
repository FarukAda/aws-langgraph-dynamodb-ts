import { withRetry, withDynamoDBRetry } from '../../../src/shared/utils/retry';

describe('retry utility', () => {
  describe('withRetry', () => {
    it('should succeed on first attempt', async () => {
      const fn = jest.fn(async () => 'success');
      const result = await withRetry(fn);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on retryable error and succeed', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce({ name: 'ThrottlingException' })
        .mockResolvedValueOnce('success');

      const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should retry on ProvisionedThroughputExceededException', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce({ name: 'ProvisionedThroughputExceededException' })
        .mockResolvedValueOnce('success');

      const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should retry on RequestLimitExceeded', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce({ name: 'RequestLimitExceeded' })
        .mockResolvedValueOnce('success');

      const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should retry on InternalServerError', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce({ name: 'InternalServerError' })
        .mockResolvedValueOnce('success');

      const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should retry on ServiceUnavailable', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce({ name: 'ServiceUnavailable' })
        .mockResolvedValueOnce('success');

      const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should not retry on non-retryable error', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('ValidationError'));

      await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow('ValidationError');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should throw after max attempts with retryable errors', async () => {
      const fn = jest.fn().mockRejectedValue({ name: 'ThrottlingException' });

      await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 })).rejects.toMatchObject({
        name: 'ThrottlingException',
      });
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should handle Error instances', async () => {
      const error = new Error('Test error');
      const fn = jest.fn().mockRejectedValue(error);

      await expect(withRetry(fn, { maxAttempts: 2 })).rejects.toThrow('Test error');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should throw Error instance after max retries with retryable Error', async () => {
      const error = new Error('Retryable error');
      error.name = 'ThrottlingException';
      const fn = jest.fn().mockRejectedValue(error);

      await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow(error);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should handle non-Error objects', async () => {
      const fn = jest.fn().mockRejectedValue('string error');

      await expect(withRetry(fn, { maxAttempts: 2 })).rejects.toThrow('string error');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should wrap non-Error object with properties on non-retryable error', async () => {
      const customError = {
        message: 'Custom error',
        code: 'CUSTOM_CODE',
        statusCode: 400,
      };
      const fn = jest.fn().mockRejectedValue(customError);

      try {
        await withRetry(fn, { maxAttempts: 2 });
        fail('Should have thrown');
      } catch (error: any) {
        expect(error).toBeInstanceOf(Error);
        expect(error.message).toBe('Custom error');
        expect(error.code).toBe('CUSTOM_CODE');
        expect(error.statusCode).toBe(400);
      }
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should handle error with code property', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce({ code: 'ThrottlingException' })
        .mockResolvedValueOnce('success');

      const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should handle null error', async () => {
      const fn = jest.fn().mockRejectedValue(null);

      await expect(withRetry(fn, { maxAttempts: 2 })).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should use default options when none provided', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce({ name: 'ThrottlingException' })
        .mockResolvedValueOnce('success');

      const result = await withRetry(fn);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should use custom retryable errors list', async () => {
      const fn = jest.fn().mockRejectedValue({ name: 'CustomError' });

      await expect(
        withRetry(fn, {
          maxAttempts: 3,
          baseDelayMs: 10,
          retryableErrors: ['CustomError'],
        }),
      ).rejects.toMatchObject({
        name: 'CustomError',
      });
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it('should apply exponential backoff with jitter', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce({ name: 'ThrottlingException' })
        .mockRejectedValueOnce({ name: 'ThrottlingException' })
        .mockResolvedValueOnce('success');

      const startTime = Date.now();
      await withRetry(fn, { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 1000 });
      const endTime = Date.now();

      expect(fn).toHaveBeenCalledTimes(3);
      // Should have some delay (at least baseDelayMs * 2 attempts)
      expect(endTime - startTime).toBeGreaterThan(50);
    });

    it('should respect maxDelayMs', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce({ name: 'ThrottlingException' })
        .mockRejectedValueOnce({ name: 'ThrottlingException' })
        .mockResolvedValueOnce('success');

      const startTime = Date.now();
      await withRetry(fn, { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 50 });
      const endTime = Date.now();

      expect(fn).toHaveBeenCalledTimes(3);
      // Should not exceed maxDelayMs significantly (with some buffer for execution time)
      expect(endTime - startTime).toBeLessThan(300);
    });

    it('should handle partial matches in error names', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce({ name: 'AWS.SimpleDB.ServiceUnavailable' })
        .mockResolvedValueOnce('success');

      const result = await withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe('withDynamoDBRetry', () => {
    it('should use DynamoDB-specific defaults', async () => {
      const fn = jest.fn(async () => 'success');
      const result = await withDynamoDBRetry(fn);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on DynamoDB throttling', async () => {
      const fn = jest
        .fn()
        .mockRejectedValueOnce({ name: 'ProvisionedThroughputExceededException' })
        .mockResolvedValueOnce('success');

      const result = await withDynamoDBRetry(fn);
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should not retry on validation errors', async () => {
      const fn = jest.fn().mockRejectedValue(new Error('ValidationException'));

      await expect(withDynamoDBRetry(fn)).rejects.toThrow('ValidationException');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should throw after 3 attempts', async () => {
      const fn = jest.fn().mockRejectedValue({ name: 'ThrottlingException' });

      await expect(withDynamoDBRetry(fn)).rejects.toMatchObject({
        name: 'ThrottlingException',
      });
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });
});
