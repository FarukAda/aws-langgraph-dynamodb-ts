import {
  validateTTLDays,
  MAX_TTL_DAYS,
  BATCH_WRITE_MAX,
  MAX_UNPROCESSED_RETRIES,
} from '../../../src/shared';

describe('constants utility', () => {
  describe('validateTTLDays', () => {
    it('should accept undefined', () => {
      expect(() => validateTTLDays(undefined)).not.toThrow();
    });

    it('should accept valid TTL days', () => {
      expect(() => validateTTLDays(1)).not.toThrow();
      expect(() => validateTTLDays(30)).not.toThrow();
      expect(() => validateTTLDays(365)).not.toThrow();
      expect(() => validateTTLDays(MAX_TTL_DAYS)).not.toThrow();
    });

    it('should reject non-integer values', () => {
      expect(() => validateTTLDays(1.5)).toThrow('TTL days must be an integer');
      expect(() => validateTTLDays(NaN)).toThrow('TTL days must be an integer');
    });

    it('should reject non-number types', () => {
      expect(() => validateTTLDays('30' as any)).toThrow('TTL days must be an integer');
      expect(() => validateTTLDays(null as any)).toThrow('TTL days must be an integer');
      expect(() => validateTTLDays({} as any)).toThrow('TTL days must be an integer');
    });

    it('should reject zero and negative values', () => {
      expect(() => validateTTLDays(0)).toThrow('TTL days must be positive');
      expect(() => validateTTLDays(-1)).toThrow('TTL days must be positive');
      expect(() => validateTTLDays(-100)).toThrow('TTL days must be positive');
    });

    it('should reject values exceeding MAX_TTL_DAYS', () => {
      expect(() => validateTTLDays(MAX_TTL_DAYS + 1)).toThrow(
        `TTL days cannot exceed ${MAX_TTL_DAYS}`,
      );
      expect(() => validateTTLDays(MAX_TTL_DAYS * 2)).toThrow(
        `TTL days cannot exceed ${MAX_TTL_DAYS}`,
      );
    });

    it('should accept boundary values', () => {
      expect(() => validateTTLDays(1)).not.toThrow();
      expect(() => validateTTLDays(MAX_TTL_DAYS)).not.toThrow();
    });

    it('should validate MAX_TTL_DAYS constant is set correctly', () => {
      expect(MAX_TTL_DAYS).toBe(365 * 5);
      expect(MAX_TTL_DAYS).toBe(1825);
    });
  });

  describe('shared constants', () => {
    it('should export BATCH_WRITE_MAX as 25', () => {
      expect(BATCH_WRITE_MAX).toBe(25);
    });

    it('should export MAX_UNPROCESSED_RETRIES as 10', () => {
      expect(MAX_UNPROCESSED_RETRIES).toBe(10);
    });
  });
});
