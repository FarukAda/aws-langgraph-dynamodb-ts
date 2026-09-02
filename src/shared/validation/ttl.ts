import { MAX_TTL_DAYS, MAX_TTL_SECONDS, S3_LIFECYCLE_SWEEP_MARGIN_DAYS } from '../constants';
import { ValidationError } from '../errors/errors';
import { validateInteger } from './primitives';

const SECONDS_PER_DAY = 24 * 60 * 60;

/** Time-to-live expressed in whole days or whole seconds. */
export type TtlOption = { days: number } | { seconds: number };

/** Positive integer no greater than `max`, with a message that names what the cap means. */
function validateWithinCap(value: number, field: string, max: number): void {
  validateInteger(value, field, { min: 1 });
  if (value > max) {
    throw new ValidationError(`${field} must be <= ${max} (five years)`, field);
  }
}

/**
 * Validate a {@link TtlOption} and resolve it to a positive number of seconds.
 * Both forms share the same five-year cap, and an object carrying both keys is
 * rejected instead of being resolved by whichever key happens to be checked first.
 */
export function resolveTtlSeconds(ttl: TtlOption): number {
  if ('days' in ttl && 'seconds' in ttl) {
    throw new ValidationError('ttl must specify either ttl.days or ttl.seconds, not both', 'ttl');
  }
  if ('days' in ttl) {
    validateWithinCap(ttl.days, 'ttl.days', MAX_TTL_DAYS);
    return ttl.days * SECONDS_PER_DAY;
  }
  validateWithinCap(ttl.seconds, 'ttl.seconds', MAX_TTL_SECONDS);
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

/**
 * Days for the S3 lifecycle rule that backs a TTL: the TTL rounded up to whole
 * days plus {@link S3_LIFECYCLE_SWEEP_MARGIN_DAYS}. S3 expires an object at the
 * first midnight UTC at least that many days after creation, while DynamoDB
 * can keep the row up to ~48 h past its `ttl`; without the margin an
 * `{ days: N }` TTL expired the object on day N exactly, stranding a live row
 * that pointed at a deleted payload until the sweep caught up.
 */
export function lifecycleExpirationDays(ttl: TtlOption): number {
  return Math.ceil(resolveTtlSeconds(ttl) / SECONDS_PER_DAY) + S3_LIFECYCLE_SWEEP_MARGIN_DAYS;
}
