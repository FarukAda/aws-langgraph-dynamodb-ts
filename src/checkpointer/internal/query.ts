import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';

/** Options for {@link beginsWithQuery}. */
export interface BeginsWithQueryOptions {
  limit?: number;
  ascending?: boolean;
}

/** Build a Query input selecting every item in a partition (all sort keys). */
export function partitionQuery(tableName: string, partition: string): QueryCommandInput {
  return {
    TableName: tableName,
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': 'PK' },
    ExpressionAttributeValues: { ':pk': partition },
  };
}

/**
 * Build a Query input selecting items whose partition equals `partition` and
 * whose sort key begins with `skPrefix`. Names are aliased so reserved words
 * never appear bare. Defaults to newest-first ordering.
 */
export function beginsWithQuery(
  tableName: string,
  partition: string,
  skPrefix: string,
  options: BeginsWithQueryOptions = {},
): QueryCommandInput {
  const params: QueryCommandInput = {
    TableName: tableName,
    KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skPrefix)',
    ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
    ExpressionAttributeValues: { ':pk': partition, ':skPrefix': skPrefix },
    ScanIndexForward: options.ascending ?? false,
  };
  if (options.limit !== undefined) params.Limit = options.limit;
  return params;
}
