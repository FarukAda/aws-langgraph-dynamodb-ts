/**
 * TTL (Time-To-Live) utility functions
 * Provide centralized TTL calculation for DynamoDB items
 */

/**
 * Calculate Unix timestamp for TTL expiration
 *
 * @param ttlDays - Number of days until expiration
 * @returns Unix timestamp in seconds for DynamoDB TTL attribute
 * @throws Error if ttlDays would cause overflow
 */
export function calculateTTLTimestamp(ttlDays: number): number {
  const ttlSeconds = ttlDays * 24 * 60 * 60;
  const timestamp = Math.floor(Date.now() / 1000) + ttlSeconds;

  // Sanity check: ensure we don't overflow Unix timestamp
  if (timestamp > 2147483647) {
    throw new Error('TTL would overflow Unix timestamp (max date: 2038-01-19)');
  }

  return timestamp;
}
