/**
 * Shared constants for validation across store and checkpointer
 */

// Common DynamoDB limits
export const MAX_TTL_DAYS = 365 * 5; // 5 years
// A DynamoDB Query page is bounded by ~1MB. 1000 iterations × 1MB = ~1GB of data,
// which is well beyond MAX_TOTAL_ITEMS_IN_MEMORY anyway, so the lower memory cap
// stays the real guard. Previously 100 — too tight for long chat histories or
// filter-heavy searches where many pages yield few matching items.
export const MAX_LOOP_ITERATIONS = 1000;
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
