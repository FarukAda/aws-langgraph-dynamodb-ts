/**
 * Hides where the current time comes from, and in which unit each reader
 * takes it.
 *
 * Every timestamp, deadline and expiry this package computes through
 * `nowIso`, `nowMs` or `nowSeconds` reads `Date.now` through here, so a test
 * that freezes it freezes all of them at once, and under a skewed clock they
 * agree with each other rather than disagreeing by a second. Two call sites
 * take their own default instead of this seam — `calculateTtlTimestamp`'s
 * `now` parameter and `createUlidFactory`'s `now` parameter, both defaulting
 * to `Date.now` directly — so freezing this module's clock alone does not
 * freeze them. That the ISO form sorts chronologically and that the TTL unit
 * is floored seconds are settled here; a caller asks for the unit it needs.
 */

/**
 * The current time as an ISO-8601 string.
 *
 * Accepts: nothing; it reads `Date.now`, which the test setup freezes.
 *
 * Returns: UTC, millisecond precision, `Z`-suffixed — the form whose byte order
 * is its chronological order, which is why it can lead a sort key unparsed.
 *
 * Throws: nothing.
 */
export function nowIso(): string {
  return new Date(Date.now()).toISOString();
}

/**
 * The current time as epoch milliseconds.
 *
 * Accepts: nothing; it reads `Date.now`, which the test setup freezes.
 *
 * Returns: the millisecond, unrounded — the unit a whole-operation deadline is
 * measured in, since a retry budget is bounded far below a second's
 * granularity of error.
 *
 * Throws: nothing.
 */
export function nowMs(): number {
  return Date.now();
}

/**
 * The current time as whole epoch seconds, the unit DynamoDB's TTL uses.
 *
 * Accepts: nothing; it reads `Date.now`, which the test setup freezes.
 *
 * Returns: the second, floored — never a fraction, which DynamoDB would reject
 * on the `ttl` attribute.
 *
 * Throws: nothing.
 *
 * Guarantees: every expiry stamp, expiry filter and ttl-anchor comparison in
 * this package reads this one seam, so they agree with each other under a
 * frozen or skewed clock rather than disagreeing by a second.
 */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
