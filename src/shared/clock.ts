/** Current time as an ISO-8601 string, derived from the (test-freezable) clock. */
export function nowIso(): string {
  return new Date(Date.now()).toISOString();
}

/**
 * Current time as whole epoch seconds, the unit DynamoDB TTL uses. Every
 * expiry stamp, expiry filter and ttl-anchor comparison reads this one seam
 * so they agree with each other under a frozen or skewed clock.
 */
export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}
