/**
 * Shared constants for validation across store and checkpointer
 */

// Common DynamoDB limits
export const MAX_TTL_DAYS = 365 * 5; // 5 years
export const MAX_LOOP_ITERATIONS = 100; // Maximum loop iterations to prevent infinite loops
export const MAX_TOTAL_ITEMS_IN_MEMORY = 10000; // Maximum items to collect in memory
export const BATCH_WRITE_MAX = 25; // DynamoDB BatchWriteItem limit per request
export const MAX_UNPROCESSED_RETRIES = 10; // Maximum retries for UnprocessedItems loops

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
}
