import type { QueryCommandInput, ScanCommandInput } from '@aws-sdk/lib-dynamodb';

/**
 * True when a row carrying a DynamoDB TTL is at or past it. DynamoDB's sweep
 * can lag up to ~48 h, so every read path applies this itself; the value is
 * epoch seconds, the unit the `ttl` attribute uses.
 */
export function isExpiredRow(row: { ttl?: number }, nowSeconds: number): boolean {
  return row.ttl !== undefined && row.ttl <= nowSeconds;
}

const TTL_FILTER = 'attribute_not_exists(#ttl) OR #ttl > :now';

/**
 * Exclude expired rows server-side, ANDing any filter the query already has.
 * A filter never replaces the in-process {@link isExpiredRow} check — it only
 * trims transfer — because the two clocks (query build, row iteration) are
 * not the same instant and DynamoDB applies filters after `Limit`.
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
