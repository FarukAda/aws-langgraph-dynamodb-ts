import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';

import { PARTITION_KEY_ATTRIBUTE, SORT_KEY_ATTRIBUTE } from '../../shared/dynamodb/table-schema';

/** Options for {@link partitionQuery}. */
export interface PartitionQueryOptions {
  consistent?: boolean;
}

/** Options for {@link beginsWithQuery}. */
export interface BeginsWithQueryOptions {
  limit?: number;
  /** Inclusive upper bound on the sort key; turns the prefix match into a `BETWEEN`. */
  beforeSortKey?: string;
  ascending?: boolean;
  consistent?: boolean;
}

/**
 * Query input selecting every item in a thread's partition.
 *
 * Accepts: the thread whose partition to read.
 *
 * Returns: the Query input, with no sort-key condition: it selects this
 * adapter's META, PAYLOAD and WRITE rows and any row another adapter left in
 * the partition — which is why every caller filters with
 * `isCheckpointerSortKey`.
 *
 * Throws: nothing.
 */
export function partitionQuery(
  tableName: string,
  partition: string,
  options: PartitionQueryOptions = {},
): QueryCommandInput {
  const params: QueryCommandInput = {
    TableName: tableName,
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': PARTITION_KEY_ATTRIBUTE },
    ExpressionAttributeValues: { ':pk': partition },
  };
  if (options.consistent) params.ConsistentRead = true;
  return params;
}

/**
 * Query input for a `begins_with` sort-key prefix.
 *
 * Accepts: `options.ascending` — sort-key order; newest-first is the default
 * because that is what "the latest checkpoint" asks for. `options.limit` — rows
 * DynamoDB evaluates per page, not a total. `options.consistent` — for a read
 * whose answer a write depends on.
 *
 * Returns: the Query input.
 *
 * Throws: nothing.
 */
export function beginsWithQuery(
  tableName: string,
  partition: string,
  skPrefix: string,
  options: BeginsWithQueryOptions = {},
): QueryCommandInput {
  const bounded = options.beforeSortKey !== undefined;
  const params: QueryCommandInput = {
    TableName: tableName,
    KeyConditionExpression: bounded
      ? '#pk = :pk AND #sk BETWEEN :skPrefix AND :before'
      : '#pk = :pk AND begins_with(#sk, :skPrefix)',
    ExpressionAttributeNames: { '#pk': PARTITION_KEY_ATTRIBUTE, '#sk': SORT_KEY_ATTRIBUTE },
    ExpressionAttributeValues: {
      ':pk': partition,
      ':skPrefix': skPrefix,
      ...(bounded ? { ':before': options.beforeSortKey } : {}),
    },
    ScanIndexForward: options.ascending ?? false,
  };
  /**
   * DynamoDB requires `Limit` to be at least 1 and rejects anything lower with
   * a raw `ValidationException`. A caller asking for nothing is answered
   * before a request is built (see `listCheckpoints`), so a non-positive value
   * reaching here means no page size was intended.
   */
  if (options.limit !== undefined && options.limit >= 1) params.Limit = options.limit;
  if (options.consistent) params.ConsistentRead = true;
  return params;
}
