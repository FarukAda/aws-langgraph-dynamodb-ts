import { MAX_TTL_DAYS, MAX_TTL_SECONDS } from '../constants';
import { validateInteger } from './primitives';

const SECONDS_PER_DAY = 24 * 60 * 60;

/** Time-to-live expressed in whole days or whole seconds. */
export type TtlOption = { days: number } | { seconds: number };

/** Validate a {@link TtlOption} and resolve it to a positive number of seconds. */
export function resolveTtlSeconds(ttl: TtlOption): number {
  if ('days' in ttl) {
    validateInteger(ttl.days, 'ttl.days', { min: 1, max: MAX_TTL_DAYS });
    return ttl.days * SECONDS_PER_DAY;
  }
  validateInteger(ttl.seconds, 'ttl.seconds', { min: 1, max: MAX_TTL_SECONDS });
  return ttl.seconds;
}

/**
 * Resolve a {@link TtlOption} into a DynamoDB TTL attribute value: the Unix
 * epoch (seconds) at which the item expires.
 *
 * @param now - Clock seam returning epoch milliseconds. Defaults to `Date.now`.
 */
export function calculateTtlTimestamp(ttl: TtlOption, now: () => number = Date.now): number {
  return Math.floor(now() / 1000) + resolveTtlSeconds(ttl);
}
