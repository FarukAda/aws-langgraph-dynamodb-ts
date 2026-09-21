import { OVERWRITE_CAS_MAX_ATTEMPTS } from '../../shared/dynamodb/conditional-put';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { ConflictError } from '../../shared/errors/errors';
import { SESSION_SORT_KEY, sessionPartition } from '../internal/keys';
import { countLiveMessages } from '../internal/message-count';
import type { HistoryContext } from '../internal/setup';
import { validateSessionId } from '../internal/validation';

/** The session row's stored count, and whether the row exists at all. */
interface ObservedCount {
  exists: boolean;
  count?: number;
}

/** Read the count this repair is about to replace, strongly consistently. */
async function observeCount(
  context: HistoryContext,
  sessionId: string,
  signal?: AbortSignal,
): Promise<ObservedCount> {
  const result = await withDynamoDBRetry(
    (request) =>
      context.client.get(
        {
          TableName: context.tableName,
          Key: { PK: sessionPartition(sessionId), SK: SESSION_SORT_KEY },
          ConsistentRead: true,
          ProjectionExpression: '#count',
          ExpressionAttributeNames: { '#count': 'messageCount' },
        },
        request,
      ),
    retryFor(context, signal),
  );
  if (!result.Item) return { exists: false };
  const count = result.Item.messageCount;
  return typeof count === 'number' ? { exists: true, count } : { exists: true };
}

/**
 * The condition admitting the repair only while the row still holds the count
 * it was computed against. A row written before the attribute existed carries
 * none, and pinning its *absence* is what makes the guard correct there too.
 */
function countGuard(observed: ObservedCount): {
  ConditionExpression: string;
  ExpressionAttributeValues?: Record<string, number>;
} {
  if (observed.count === undefined) {
    return { ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(#count)' };
  }
  return {
    ConditionExpression: 'attribute_exists(PK) AND #count = :expected',
    ExpressionAttributeValues: { ':expected': observed.count },
  };
}

/** Write the recomputed count, pinned to what the row held when it was computed. */
async function writeCount(
  context: HistoryContext,
  sessionId: string,
  count: number,
  observed: ObservedCount,
  signal?: AbortSignal,
): Promise<void> {
  const guard = countGuard(observed);
  await withDynamoDBRetry(
    (request) =>
      context.client.update(
        {
          TableName: context.tableName,
          Key: { PK: sessionPartition(sessionId), SK: SESSION_SORT_KEY },
          UpdateExpression: 'SET #count = :count',
          ExpressionAttributeNames: { '#count': 'messageCount' },
          ExpressionAttributeValues: { ':count': count, ...guard.ExpressionAttributeValues },
          ConditionExpression: guard.ConditionExpression,
        },
        request,
      ),
    retryFor(context, signal),
  );
}

/**
 * Recompute `messageCount` from the number of stored message items and write it
 * back, repairing drift. The append path keeps the count consistent
 * transactionally, so this is only needed after external corruption.
 *
 * **Safe to run on a live session.** The count is written under a condition on
 * the value the row held when the count was computed, so an append landing in
 * between makes the write fail rather than clobber the increment; the tool then
 * recounts and tries again. Writing it unconditionally — which is what this did
 * — silently discarded concurrent appends on exactly the sessions an operator
 * reaches for this tool to fix.
 *
 * Accepts: `sessionId` — validated, and an existing session: repairing one that
 * does not exist would mean creating it. `signal` — aborts the reads.
 *
 * Returns: the count now stored, which is the number of messages a reader would
 * see.
 *
 * Throws: ValidationError naming `sessionId`; {@link ConflictError} when the
 * session does not exist — rather than creating a permanent, TTL-less
 * metadata-only row — and when it stays too busy to settle within
 * {@link OVERWRITE_CAS_MAX_ATTEMPTS} attempts; `FORMAT_UNSUPPORTED` for a
 * message row a newer release wrote, which `getMessages` refuses too; whatever
 * the reads and the write throw.
 *
 * Guarantees: safe on a live session. The write is pinned to the value the row
 * held when the count was computed, so an append landing in between fails the
 * write rather than clobbering its increment, and the tool recounts. Expired
 * messages are not counted, so the repaired number agrees with what
 * `getMessages` returns rather than with what the table still holds.
 */
export async function reconcileMessageCount(
  context: HistoryContext,
  sessionId: string,
  signal?: AbortSignal,
): Promise<number> {
  validateSessionId(sessionId);
  for (let attempt = 1; attempt <= OVERWRITE_CAS_MAX_ATTEMPTS; attempt++) {
    const observed = await observeCount(context, sessionId, signal);
    if (!observed.exists) {
      throw new ConflictError(
        `Cannot reconcile messageCount: session "${sessionId}" does not exist`,
      );
    }
    const count = await countLiveMessages(context, sessionId, signal);
    try {
      await writeCount(context, sessionId, count, observed, signal);
      return count;
    } catch (error) {
      if ((error as { name?: string }).name !== 'ConditionalCheckFailedException') throw error;
    }
  }
  throw new ConflictError(
    `Cannot reconcile messageCount: session "${sessionId}" changed during every one of ` +
      `${OVERWRITE_CAS_MAX_ATTEMPTS} attempts; retry when it is quieter`,
  );
}
