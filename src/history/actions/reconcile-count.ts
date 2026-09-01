import type { NativeAttributeValue } from '@aws-sdk/lib-dynamodb';

import { nowSeconds } from '../../shared/clock';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { ConflictError } from '../../shared/errors/errors';
import { SESSION_SORT_KEY, sessionPartition } from '../internal/keys';
import { messageQuery } from '../internal/query';
import type { HistoryContext } from '../internal/setup';
import { validateSessionId } from '../internal/validation';

/**
 * Count only the rows `getMessages` would return: an expired message that
 * DynamoDB's TTL sweep has not yet removed is invisible to the read path, so
 * counting it would "repair" `messageCount` to a number no reader ever sees.
 */
async function countMessages(context: HistoryContext, sessionId: string): Promise<number> {
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
    const page = await withDynamoDBRetry(() =>
      context.client.query({ ...base, ExclusiveStartKey: startKey }),
    );
    total += page.Count ?? 0;
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return total;
}

/**
 * Recompute `messageCount` from the authoritative number of stored message items
 * and write it back, repairing any drift. A repair tool: the append path keeps
 * the count consistent transactionally, so this is only needed after external
 * corruption. Run it when the session is quiescent — it `SET`s the count, so a
 * concurrent append's increment could be clobbered. Requires the session to
 * already exist; reconciling a nonexistent session throws {@link ConflictError}
 * rather than creating a permanent, TTL-less metadata-only row. Returns the
 * reconciled count.
 */
export async function reconcileMessageCount(
  context: HistoryContext,
  sessionId: string,
): Promise<number> {
  validateSessionId(sessionId);
  const count = await countMessages(context, sessionId);
  try {
    await withDynamoDBRetry(() =>
      context.client.update({
        TableName: context.tableName,
        Key: { PK: sessionPartition(sessionId), SK: SESSION_SORT_KEY },
        UpdateExpression: 'SET #count = :count',
        ExpressionAttributeNames: { '#count': 'messageCount' },
        ExpressionAttributeValues: { ':count': count },
        ConditionExpression: 'attribute_exists(PK)',
      }),
    );
  } catch (error) {
    if ((error as { name?: string }).name === 'ConditionalCheckFailedException') {
      throw new ConflictError(
        `Cannot reconcile messageCount: session "${sessionId}" does not exist`,
        error as Error,
      );
    }
    throw error;
  }
  return count;
}
