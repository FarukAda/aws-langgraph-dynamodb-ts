/**
 * Shared constants for validation across store and checkpointer
 */

// Common DynamoDB limits
export const MAX_TTL_DAYS = 365 * 5; // 5 years
export const MAX_LOOP_ITERATIONS = 100; // Maximum loop iterations to prevent infinite loops
export const MAX_TOTAL_ITEMS_IN_MEMORY = 10000; // Maximum items to collect in memory

/**
 * Validate TTL days (shared logic)
 */
export function validateTTLDays(ttlDays: number | undefined): void {
  if (ttlDays === undefined) {
    return;
  }

  if (typeof ttlDays !== 'number' || !Number.isInteger(ttlDays)) {
    throw new Error('TTL days must be an integer');
  }

  if (ttlDays <= 0) {
    throw new Error('TTL days must be positive');
  }

  if (ttlDays > MAX_TTL_DAYS) {
    throw new Error(`TTL days cannot exceed ${MAX_TTL_DAYS}`);
  }

  // Check for overflow when converting to Unix timestamp
  const futureTimestamp = Math.floor(Date.now() / 1000) + ttlDays * 24 * 60 * 60;
  if (futureTimestamp > 2147483647) {
    // Max 32-bit integer
    throw new Error('TTL would overflow Unix timestamp (max date: 2038-01-19)');
  }
}
