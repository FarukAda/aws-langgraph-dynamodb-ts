import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';

import { messageSortKeyPrefix, sessionPartition } from './keys';

/** Options for {@link sessionItemsQuery}. */
export interface SessionItemsQueryOptions {
  consistent?: boolean;
}

/** Query input selecting every item in a session's partition (messages + metadata). */
export function sessionItemsQuery(
  tableName: string,
  sessionId: string,
  options: SessionItemsQueryOptions = {},
): QueryCommandInput {
  const params: QueryCommandInput = {
    TableName: tableName,
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': 'PK' },
    ExpressionAttributeValues: { ':pk': sessionPartition(sessionId) },
  };
  if (options.consistent) params.ConsistentRead = true;
  return params;
}

/** Options for {@link messageQuery}. */
export interface MessageQueryOptions extends SessionItemsQueryOptions {
  /** Walk the messages newest-first; the caller restores chronological order. */
  descending?: boolean;
  /** Cap the rows DynamoDB evaluates per page. */
  limit?: number;
  /**
   * Exclusive upper sort-key bound. Expressed as `BETWEEN prefix AND bound`
   * because a key condition allows one sort-key operator: the bound is the
   * message prefix plus the ULID time characters of an instant, so every
   * real message key from that millisecond onwards sorts strictly after it.
   */
  beforeSortKey?: string;
}

/** Query input selecting a session's message items, chronological unless `descending`. */
export function messageQuery(
  tableName: string,
  sessionId: string,
  options: MessageQueryOptions = {},
): QueryCommandInput {
  const params: QueryCommandInput = {
    TableName: tableName,
    KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skp)',
    ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
    ExpressionAttributeValues: {
      ':pk': sessionPartition(sessionId),
      ':skp': messageSortKeyPrefix(),
    },
    ScanIndexForward: !options.descending,
  };
  if (options.beforeSortKey !== undefined) {
    params.KeyConditionExpression = '#pk = :pk AND #sk BETWEEN :skp AND :before';
    params.ExpressionAttributeValues![':before'] = options.beforeSortKey;
  }
  if (options.limit !== undefined) params.Limit = options.limit;
  if (options.consistent) params.ConsistentRead = true;
  return params;
}
