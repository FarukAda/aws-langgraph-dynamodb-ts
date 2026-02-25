/**
 * TTL (Time-To-Live) utility functions
 * Provide centralized TTL calculation for DynamoDB items
 */

/**
 * Calculate Unix timestamp for TTL expiration from seconds
 *
 * @param ttlSeconds - Number of seconds until expiration
 * @returns Unix timestamp in seconds for DynamoDB TTL attribute
 */
export function calculateTTLTimestampFromSeconds(ttlSeconds: number): number {
  return Math.floor(Date.now() / 1000) + ttlSeconds;
}

/**
 * Calculate Unix timestamp for TTL expiration from days
 *
 * @param ttlDays - Number of days until expiration
 * @returns Unix timestamp in seconds for DynamoDB TTL attribute
 * @throws Error if ttlDays would cause overflow
 */
export function calculateTTLTimestamp(ttlDays: number): number {
  return calculateTTLTimestampFromSeconds(ttlDays * 24 * 60 * 60);
}
