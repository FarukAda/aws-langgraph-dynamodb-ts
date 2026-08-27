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

/** Query input selecting a session's message items in chronological order. */
export function messageQuery(tableName: string, sessionId: string): QueryCommandInput {
  return {
    TableName: tableName,
    KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skp)',
    ExpressionAttributeNames: { '#pk': 'PK', '#sk': 'SK' },
    ExpressionAttributeValues: {
      ':pk': sessionPartition(sessionId),
      ':skp': messageSortKeyPrefix(),
    },
    ScanIndexForward: true,
  };
}
