/**
 * Hides how a `ttl` option becomes an expiry.
 *
 * A caller gives days or seconds. The one-unit rule, the five-year cap, the
 * epoch second DynamoDB's TTL attribute takes, and the S3 lifecycle days that
 * keep an offloaded object alive past its row's sweep lag are all derived
 * here, so the two spellings of the `ttl` option are accepted or rejected
 * alike and no reader re-derives one unit from the other itself. A stored
 * row's own epoch-second `ttl` is converted to milliseconds for `Date` where
 * that row is read, not here.
 */

import { validationError } from '../errors/errors';
import { allKeysOf, assertShape } from './option-shape';
import { assertInteger } from './primitives';

const SECONDS_PER_DAY = 24 * 60 * 60;

/** Maximum TTL expressed in days (5 years). */
export const MAX_TTL_DAYS = 365 * 5;

/** Maximum TTL expressed in seconds: the same five years as {@link MAX_TTL_DAYS}. */
export const MAX_TTL_SECONDS = MAX_TTL_DAYS * 24 * 60 * 60;

/**
 * Extra days an S3 lifecycle rule adds over the TTL it backs, so the offloaded
 * object outlives its row's expiry, never the other way round. DynamoDB
 * deletes an expired item typically within a few days of its `ttl`, with no
 * fixed bound
 * (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html);
 * the margin does not span that lag, and does not need to, because every read
 * hides a row past its `ttl`.
 */
export const S3_LIFECYCLE_SWEEP_MARGIN_DAYS = 2;

/** Time-to-live expressed in whole days or whole seconds. */
export type TtlOption = { days: number } | { seconds: number };

/**
 * Every key some shape of `T` declares, taken one shape at a time: a
 * conditional type over a bare type parameter is applied to each member of a
 * union separately, so for {@link TtlOption} this is `'days' | 'seconds'`.
 */
type KeyOfEachShape<T> = T extends object ? keyof T : never;

/**
 * The units {@link TtlOption} declares. `allKeysOf<TtlOption>` cannot check
 * this list: over a union its parameter is itself a union of one key map per
 * shape, so `{ days: 'days' }` alone satisfies the first shape and compiles.
 * Listing the keys of every shape as one record restores the check, so leaving
 * a unit out, inventing one, or adding a shape to the union without listing
 * its unit here fails to compile.
 */
const TTL_KEYS = allKeysOf<Record<KeyOfEachShape<TtlOption>, number>>({
  days: 'days',
  seconds: 'seconds',
});

/** Positive integer no greater than `max`, with a message that names what the cap means. */
function assertWithinCap(value: number, field: string, max: number): void {
  assertInteger(value, field, { min: 1 });
  if (value > max) {
    throw validationError(`${field} must be <= ${max} (five years)`, field);
  }
}

/**
 * Reject a `ttl` that is not an object at all, carries a key other than a
 * unit, or names neither unit or both. The stray key is checked before the
 * units, so `{ day: 1 }` names the key the caller wrote rather than a unit it
 * did not.
 */
function assertOneUnit(ttl: TtlOption): void {
  if (typeof ttl !== 'object' || ttl === null) {
    throw validationError('ttl must be an object: { days } or { seconds }', 'ttl');
  }
  assertShape(ttl, TTL_KEYS, 'ttl');
  const days = 'days' in ttl;
  const seconds = 'seconds' in ttl;
  if (days && seconds) {
    throw validationError('ttl must specify either ttl.days or ttl.seconds, not both', 'ttl');
  }
  if (!days && !seconds) {
    throw validationError('ttl must specify either ttl.days or ttl.seconds', 'ttl');
  }
}

/**
 * A {@link TtlOption} resolved to a positive number of seconds.
 *
 * Accepts: `ttl` — declared as the two-shape union; a JavaScript caller, or a
 * config built from JSON, can also reach `undefined`, a non-object, `{}`, an
 * object carrying both keys and one carrying any other key, and each is
 * rejected. Within a shape the value must be an integer of at least 1.
 *
 * Returns: whole seconds, `days × 86400` for the days form.
 *
 * Throws: `VALIDATION`, in this order, naming `ttl` for a value that is not
 * an object, `ttl.<key>` for a key other than `days` or `seconds`, `ttl` for
 * an object naming neither unit or both, and `ttl.days` or `ttl.seconds` for a
 * value outside 1..five years. Both forms share that cap, so the two spellings
 * of one duration are accepted or rejected alike.
 */
export function resolveTtlSeconds(ttl: TtlOption): number {
  assertOneUnit(ttl);
  if ('days' in ttl) {
    assertWithinCap(ttl.days, 'ttl.days', MAX_TTL_DAYS);
    return ttl.days * SECONDS_PER_DAY;
  }
  assertWithinCap(ttl.seconds, 'ttl.seconds', MAX_TTL_SECONDS);
  return ttl.seconds;
}

/**
 * The value DynamoDB's TTL attribute takes for an item written now: the Unix
 * epoch second at which it expires.
 *
 * Accepts: `ttl` — as {@link resolveTtlSeconds}. `now` — a clock returning
 * epoch **milliseconds**, defaulting to `Date.now`; supplied by tests and by
 * the adapters' clock seam.
 *
 * Returns: `floor(now() / 1000) + resolveTtlSeconds(ttl)`. Whole seconds,
 * because DynamoDB reads the attribute as an epoch-second Number
 * (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/time-to-live-ttl-before-you-start.html).
 *
 * Throws: whatever {@link resolveTtlSeconds} throws.
 */
export function calculateTtlTimestamp(ttl: TtlOption, now: () => number = Date.now): number {
  return Math.floor(now() / 1000) + resolveTtlSeconds(ttl);
}

/**
 * The `Days` of the S3 lifecycle expiration rule that backs a TTL.
 *
 * Accepts: `ttl` — as {@link resolveTtlSeconds}.
 *
 * Returns: the TTL rounded **up** to whole days plus
 * {@link S3_LIFECYCLE_SWEEP_MARGIN_DAYS}, so always at least
 * `1 + margin`.
 *
 * Throws: whatever {@link resolveTtlSeconds} throws.
 *
 * Guarantees: the object outlives the row that points at it. S3 expires an
 * object at the first midnight UTC at least `Days` after creation, while
 * DynamoDB deletes an expired item typically within a few days of its `ttl`,
 * with no fixed bound
 * (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/TTL.html).
 * The margin keeps the object past the row's expiry, which a bare
 * `{ days: N }` did not; a row that DynamoDB has not yet deleted is hidden by
 * every read, so the object going first is never observed.
 */
export function lifecycleExpirationDays(ttl: TtlOption): number {
  return Math.ceil(resolveTtlSeconds(ttl) / SECONDS_PER_DAY) + S3_LIFECYCLE_SWEEP_MARGIN_DAYS;
}
