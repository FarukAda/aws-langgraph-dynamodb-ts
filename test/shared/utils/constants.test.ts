import { validateTTLDays, MAX_TTL_DAYS } from '../../../src/shared';

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

    it('should reject values that would overflow Unix timestamp', () => {
      // Mock Date.now() to simulate being close to 2038
      // Set date to 2037-01-01 to ensure overflow with reasonable TTL
      const mockDate = new Date('2037-01-01T00:00:00Z').getTime();
      jest.spyOn(Date, 'now').mockReturnValue(mockDate);

      // 400 days from 2037 would overflow the 2038-01-19 limit
      expect(() => validateTTLDays(400)).toThrow('TTL would overflow Unix timestamp');

      // Restore Date.now()
      jest.restoreAllMocks();
    });

    it('should accept boundary values', () => {
      expect(() => validateTTLDays(1)).not.toThrow();

      // Test a safe value near the boundary
      const safeDays = Math.floor((2147483647 - Date.now() / 1000) / (24 * 60 * 60)) - 10;
      if (safeDays > 0 && safeDays <= MAX_TTL_DAYS) {
        expect(() => validateTTLDays(safeDays)).not.toThrow();
      }
    });

    it('should validate MAX_TTL_DAYS constant is set correctly', () => {
      expect(MAX_TTL_DAYS).toBe(365 * 5);
      expect(MAX_TTL_DAYS).toBe(1825);
    });
  });
});
