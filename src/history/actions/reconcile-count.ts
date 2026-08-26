import type { NativeAttributeValue } from '@aws-sdk/lib-dynamodb';

import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { ConflictError } from '../../shared/errors/errors';
import { validateNonEmptyString } from '../../shared/validation/primitives';
import { SESSION_SORT_KEY, sessionPartition } from '../internal/keys';
import { messageQuery } from '../internal/query';
import type { HistoryContext } from '../internal/setup';

async function countMessages(context: HistoryContext, sessionId: string): Promise<number> {
  const base = messageQuery(context.tableName, sessionId);
  let total = 0;
  let startKey: Record<string, NativeAttributeValue> | undefined;
  do {
    const page = await withDynamoDBRetry(() =>
      context.client.query({ ...base, Select: 'COUNT', ExclusiveStartKey: startKey }),
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
  validateNonEmptyString(sessionId, 'sessionId');
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
