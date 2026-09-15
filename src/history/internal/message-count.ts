import type { NativeAttributeValue } from '@aws-sdk/lib-dynamodb';

import { nowSeconds } from '../../shared/clock';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { messageQuery } from './query';
import type { HistoryContext } from './setup';

/**
 * The number of message rows a session holds, counted the way the read path
 * counts them.
 *
 * Only rows `getMessages` would return are counted: an expired message that
 * DynamoDB's TTL sweep has not yet removed is invisible to every reader, so
 * counting it would "repair" `messageCount` to a number nobody ever sees. The
 * count is therefore a definition, not an implementation detail — it is what
 * makes the repaired value agree with what the session returns.
 *
 * Accepts: `sessionId` — validated by the caller. `signal` — aborts the reads.
 *
 * Returns: how many messages a reader would actually see right now.
 *
 * Throws: whatever the query throws after retries; `AbortError`.
 *
 * Guarantees: `Select: COUNT`, so no message payload is read or downloaded
 * however large the session is. The paging is deliberately uncapped: a partial
 * count is not a repair, it is a new and wrong number, so the count either
 * completes or fails.
 */
export async function countLiveMessages(
  context: HistoryContext,
  sessionId: string,
  signal?: AbortSignal,
): Promise<number> {
  const query = messageQuery(context.tableName, sessionId);
  const base = {
    ...query,
    Select: 'COUNT' as const,
    FilterExpression: 'attribute_not_exists(#ttl) OR #ttl > :now',
    ExpressionAttributeNames: { ...query.ExpressionAttributeNames, '#ttl': 'ttl' },
    ExpressionAttributeValues: { ...query.ExpressionAttributeValues, ':now': nowSeconds() },
  };
  let total = 0;
  let startKey: Record<string, NativeAttributeValue> | undefined;
  do {
    const page = await withDynamoDBRetry(
      () => context.client.query({ ...base, ExclusiveStartKey: startKey }),
      retryFor(context, signal),
    );
    total += page.Count ?? 0;
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return total;
}
