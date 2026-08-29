import { randomUUID } from 'node:crypto';

import { getCancellationReasons } from '../../shared/dynamodb/cancellation';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { SESSION_SORT_KEY, sessionPartition } from './keys';
import { removeRolledBackTitle } from './session-title';
import type { HistoryContext } from './setup';

/**
 * True when a TransactWriteItems cancellation was caused by a
 * ConditionalCheckFailed reason. Named distinctly from
 * checkpointer/actions/put-writes.ts's isConditionalCheckFailed, which
 * checks a different thing entirely (a raw PutItem exception name, not a
 * transaction cancellation reason) — this function had that same name
 * until now, a real trap for whoever read one assuming it was the other.
 */
function isCancelledByCondition(error: Error): boolean {
  const reasons = getCancellationReasons(error);
  return reasons?.[0]?.Code === 'ConditionalCheckFailed';
}

/**
 * Subtract a previously-added count from the session, leaving it consistent.
 * Guarded so a concurrently-deleted SESSION row is never resurrected as a
 * permanent, ttl-less junk row: if the row is already gone there is nothing
 * to revert, so that specific condition failure is swallowed rather than
 * surfaced — this runs only from an already-in-progress rollback, where a
 * spurious error for a no-op would misrepresent what happened.
 *
 * Deliberately does not revert a `forceTtlRefresh`-driven ttl SET from an
 * earlier committed chunk: the healed anchor is never shorter than what
 * was there before, so leaving it in place after a rollback only means the
 * session's metadata row outlives its content a bit longer than ideal —
 * self-healing (the next successful append, or DynamoDB's own TTL sweep,
 * resolves it), unlike reverting, which would need to re-check for a
 * concurrent legitimate extension to avoid regressing it. See README.md's
 * "TTL expiry" section.
 */
export async function revertSessionCount(
  context: HistoryContext,
  sessionId: string,
  delta: number,
): Promise<void> {
  if (delta === 0) return;
  const update = {
    TableName: context.tableName,
    Key: { PK: sessionPartition(sessionId), SK: SESSION_SORT_KEY },
    UpdateExpression: 'ADD #count :neg',
    ConditionExpression: 'attribute_exists(PK)',
    ExpressionAttributeNames: { '#count': 'messageCount' },
    ExpressionAttributeValues: { ':neg': -delta },
  };
  const input = { TransactItems: [{ Update: update }], ClientRequestToken: randomUUID() };
  try {
    await withDynamoDBRetry(() => context.client.transactWrite(input));
  } catch (error) {
    if (isCancelledByCondition(error as Error)) return;
    throw error;
  }
}

/**
 * Undo a rolled-back append's effect on the session row.
 *
 * When this call is the one that created the row — `createdAt` still equals
 * this call's timestamp, and the only messages counted on it are the ones
 * being reverted — the whole row is deleted. Without that, a failed first
 * append left a "ghost session": `title`, `createdAt` and `sessionId` are all
 * written via `if_not_exists`, so they were never reverted and never set
 * again, leaving `listSessions()` reporting a session with `messageCount: 0`
 * whose title still held up to 80 characters of a message the caller was told
 * had not persisted, with no API to clear it.
 *
 * Both conditions are load-bearing. `createdAt = :now` establishes that this
 * call created the row; `messageCount = :total` establishes that nothing else
 * has added to it since. A concurrent append to the same brand-new session
 * fails the count check, because deleting the row would destroy that caller's
 * committed messages — so it falls through to the plain decrement, and then
 * strips just the title this call contributed, which is the only part of the
 * row still carrying rolled-back message content.
 */
export async function revertSessionCreation(
  context: HistoryContext,
  sessionId: string,
  total: number,
  createdAt: string,
  title?: string,
): Promise<void> {
  if (total === 0) return;
  const input = {
    TransactItems: [
      {
        Delete: {
          TableName: context.tableName,
          Key: { PK: sessionPartition(sessionId), SK: SESSION_SORT_KEY },
          ConditionExpression: '#count = :total AND #c = :now',
          ExpressionAttributeNames: { '#count': 'messageCount', '#c': 'createdAt' },
          ExpressionAttributeValues: { ':total': total, ':now': createdAt },
        },
      },
    ],
    ClientRequestToken: randomUUID(),
  };
  try {
    await withDynamoDBRetry(() => context.client.transactWrite(input));
    return;
  } catch (error) {
    if (!isCancelledByCondition(error as Error)) throw error;
  }
  await revertSessionCount(context, sessionId, total);
  if (title !== undefined) await removeRolledBackTitle(context, sessionId, createdAt, title);
}
