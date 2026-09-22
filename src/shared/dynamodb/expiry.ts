import type { QueryCommandInput, ScanCommandInput } from '@aws-sdk/lib-dynamodb';

/**
 * Whether a row has reached its TTL.
 *
 * Accepts: `row` — any row; one without a `ttl` attribute never expires.
 * `nowSeconds` — the current epoch **second**, the unit the attribute uses.
 *
 * Returns: true when `ttl <= nowSeconds`, so the expiry instant itself counts
 * as expired.
 *
 * Throws: nothing.
 *
 * Guarantees: an expired row is absent to every reader even while DynamoDB's
 * own sweep lags, which it may by up to 48 hours
 * (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/howitworks-ttl.html).
 */
export function isExpiredRow(row: { ttl?: number }, nowSeconds: number): boolean {
  return row.ttl !== undefined && row.ttl <= nowSeconds;
}

const TTL_FILTER = 'attribute_not_exists(#ttl) OR #ttl > :now';

/**
 * The same query with expired rows filtered out server-side.
 *
 * Accepts: `params` — a Query or Scan input, with or without a
 * `FilterExpression`; an existing one is ANDed rather than replaced.
 * `nowSeconds` — the epoch second to compare against.
 *
 * Returns: a copy carrying the added filter and the `#ttl` / `:now` aliases. No
 * other call site in this package uses those two names, so the merge cannot
 * shadow a caller's own alias.
 *
 * Throws: nothing.
 *
 * Guarantees: this trims transfer only. It never replaces the in-process
 * {@link isExpiredRow} check, because the query is built and its rows are read
 * at two different instants, and DynamoDB applies a filter *after* `Limit`.
 */
export function withoutExpired<T extends QueryCommandInput | ScanCommandInput>(
  params: T,
  nowSeconds: number,
): T {
  return {
    ...params,
    FilterExpression: params.FilterExpression
      ? `(${params.FilterExpression}) AND (${TTL_FILTER})`
      : TTL_FILTER,
    ExpressionAttributeNames: { ...params.ExpressionAttributeNames, '#ttl': 'ttl' },
    ExpressionAttributeValues: { ...params.ExpressionAttributeValues, ':now': nowSeconds },
  };
}
