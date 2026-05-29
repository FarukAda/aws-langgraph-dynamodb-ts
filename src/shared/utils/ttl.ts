/**
 * TTL (Time-To-Live) utility functions
 * Provide centralized TTL calculation for DynamoDB items
 */

/** 100 years in seconds — comfortable upper bound for any TTL use case. */
const MAX_TTL_SECONDS = 100 * 365 * 24 * 60 * 60;

/**
 * Calculate Unix timestamp for TTL expiration from seconds.
 *
 * Validates the input so callers can't silently produce absurd timestamps
 * (e.g. `Number.MAX_SAFE_INTEGER`) that DynamoDB would reject at write time.
 *
 * @param ttlSeconds - Number of seconds until expiration (integer > 0, ≤ 100 years)
 * @param now - Clock seam returning the current epoch in ms. Defaults to
 *   `Date.now`; injectable so tests can pin the clock without fake timers.
 * @returns Unix timestamp in seconds for DynamoDB TTL attribute
 * @throws Error if ttlSeconds is not a positive finite integer within the allowed range
 */
export function calculateTTLTimestampFromSeconds(
  ttlSeconds: number,
  now: () => number = Date.now,
): number {
  if (typeof ttlSeconds !== 'number' || !Number.isInteger(ttlSeconds)) {
    throw new Error('ttlSeconds must be an integer');
  }
  if (ttlSeconds <= 0) {
    throw new Error('ttlSeconds must be positive');
  }
  if (ttlSeconds > MAX_TTL_SECONDS) {
    throw new Error(`ttlSeconds cannot exceed ${MAX_TTL_SECONDS} (100 years)`);
  }
  return Math.floor(now() / 1000) + ttlSeconds;
}

/**
 * Calculate Unix timestamp for TTL expiration from days
 *
 * @param ttlDays - Number of days until expiration
 * @param now - Clock seam returning the current epoch in ms. Defaults to
 *   `Date.now`; forwarded to {@link calculateTTLTimestampFromSeconds}.
 * @returns Unix timestamp in seconds for DynamoDB TTL attribute
 * @throws Error if ttlDays would cause overflow
 */
export function calculateTTLTimestamp(ttlDays: number, now: () => number = Date.now): number {
  return calculateTTLTimestampFromSeconds(ttlDays * 24 * 60 * 60, now);
}
