import type { NativeAttributeValue } from '@aws-sdk/lib-dynamodb';

import { nowSeconds } from '../../shared/clock';
import { isExpiredRow } from '../../shared/dynamodb/expiry';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { assertReadableRow, type VersionedRow } from '../../shared/dynamodb/row-version';
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
 * makes the repaired value agree with what the session returns. For the same
 * reason a message a newer release wrote is refused rather than counted:
 * `getMessages` refuses it.
 *
 * Accepts: `sessionId` — validated by the caller. `signal` — aborts the reads.
 *
 * Returns: how many messages a reader would actually see right now.
 *
 * Throws: `FORMAT_UNSUPPORTED` for a message row a newer release wrote, checked
 * before the row's ttl as `getMessages` checks it; whatever the query throws
 * after retries; `AbortError`.
 *
 * Guarantees: each row comes back projected to its format version and ttl, so
 * no message payload is transferred however large the session is. Both checks
 * run here rather than in a filter, because a filter would drop an expired row
 * before its version could be checked. The paging is deliberately uncapped: a
 * partial count is not a repair, it is a new and wrong number, so the count
 * either completes or fails.
 */
export async function countLiveMessages(
  context: HistoryContext,
  sessionId: string,
  signal?: AbortSignal,
): Promise<number> {
  const now = nowSeconds();
  const query = messageQuery(context.tableName, sessionId);
  const base = {
    ...query,
    ProjectionExpression: '#v, #ttl',
    ExpressionAttributeNames: { ...query.ExpressionAttributeNames, '#v': 'v', '#ttl': 'ttl' },
  };
  let total = 0;
  let startKey: Record<string, NativeAttributeValue> | undefined;
  do {
    const page = await withDynamoDBRetry(
      () => context.client.query({ ...base, ExclusiveStartKey: startKey }),
      retryFor(context, signal),
    );
    for (const row of (page.Items ?? []) as (VersionedRow & { ttl?: number })[]) {
      assertReadableRow(row, 'message');
      if (!isExpiredRow(row, now)) total += 1;
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return total;
}
