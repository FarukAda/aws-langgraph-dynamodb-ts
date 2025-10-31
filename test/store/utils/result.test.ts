import { Ok, Err, isOk, isErr, unwrap, unwrapOr, type Result } from '../../../src/store/utils';

describe('result utility', () => {
  describe('Ok', () => {
    it('should create a successful result', () => {
      const result = Ok('success');
      expect(result.success).toBe(true);
      expect((result as any).data).toBe('success');
    });

    it('should work with different data types', () => {
      const numberResult = Ok(42);
      const objectResult = Ok({ key: 'value' });
      const arrayResult = Ok([1, 2, 3]);

      expect((numberResult as any).data).toBe(42);
      expect((objectResult as any).data).toEqual({ key: 'value' });
      expect((arrayResult as any).data).toEqual([1, 2, 3]);
    });
  });

  describe('Err', () => {
    it('should create an error result', () => {
      const result = Err(new Error('failed'));
      expect(result.success).toBe(false);
      expect((result as any).error).toBeInstanceOf(Error);
      expect((result as any).error.message).toBe('failed');
    });

    it('should work with custom error types', () => {
      const result = Err('string error');
      expect(result.success).toBe(false);
      expect((result as any).error).toBe('string error');
    });
  });

  describe('isOk', () => {
    it('should return true for Ok results', () => {
      const result: Result<string> = Ok('success');
      expect(isOk(result)).toBe(true);
    });

    it('should return false for Err results', () => {
      const result: Result<string> = Err(new Error('failed'));
      expect(isOk(result)).toBe(false);
    });

    it('should narrow type correctly', () => {
      const result: Result<string> = Ok('success');
      if (isOk(result)) {
        // TypeScript should now result.data existing here
        expect(result.data).toBe('success');
      }
    });
  });

  describe('isErr', () => {
    it('should return false for Ok results', () => {
      const result: Result<string> = Ok('success');
      expect(isErr(result)).toBe(false);
    });

    it('should return true for Err results', () => {
      const result: Result<string> = Err(new Error('failed'));
      expect(isErr(result)).toBe(true);
    });

    it('should narrow type correctly', () => {
      const result: Result<string> = Err(new Error('failed'));
      if (isErr(result)) {
        // TypeScript should know the result.error exists here
        expect(result.error).toBeInstanceOf(Error);
      }
    });
  });

  describe('unwrap', () => {
    it('should return data for Ok results', () => {
      const result = Ok('success');
      expect(unwrap(result)).toBe('success');
    });

    it('should throw error for Err results', () => {
      const error = new Error('failed');
      const result = Err(error);
      expect(() => unwrap(result)).toThrow(error);
    });

    it('should work with different data types', () => {
      const numberResult = Ok(42);
      const objectResult = Ok({ key: 'value' });

      expect(unwrap(numberResult)).toBe(42);
      expect(unwrap(objectResult)).toEqual({ key: 'value' });
    });
  });

  describe('unwrapOr', () => {
    it('should return data for Ok results', () => {
      const result = Ok('success');
      expect(unwrapOr(result, 'default')).toBe('success');
    });

    it('should return default value for Err results', () => {
      const result = Err(new Error('failed'));
      expect(unwrapOr(result, 'default')).toBe('default');
    });

    it('should work with different data types', () => {
      const okNumber = Ok(42);
      const errNumber = Err(new Error('failed'));

      expect(unwrapOr(okNumber, 0)).toBe(42);
      expect(unwrapOr(errNumber, 0)).toBe(0);
    });
  });
});
