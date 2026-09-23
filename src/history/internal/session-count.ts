import { randomUUID } from 'node:crypto';

import { nowMs } from '../../shared/clock';
import { MAX_WRITE_LIFETIME_MS } from '../../shared/constants';
import { conditionFailedAt } from '../../shared/dynamodb/cancellation';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { PARTITION_KEY_ATTRIBUTE } from '../../shared/dynamodb/table-schema';
import type { SessionId } from './parse';
import { sessionRowKey } from './rows';
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
  return conditionFailedAt(error, 0);
}

/**
 * Subtract a previously-added count from the session, leaving it consistent.
 * Guarded so a concurrently-deleted SESSION row is never resurrected as a
 * permanent, ttl-less junk row: if the row is already gone there is nothing
 * to revert, so that specific condition failure is swallowed rather than
 * surfaced — this runs only from an already-in-progress rollback, where a
 * spurious error for a no-op would misrepresent what happened.
 *
 * The same condition also pins the *incarnation*: `createdAt <= createdBefore`
 * (this call's own append timestamp). A session `clear()`-ed and re-created by
 * another caller between this call's commit and its rollback carries a later
 * `createdAt`; decrementing it would corrupt the new incarnation's count, and
 * its rows were never this call's to revert. That rejection is swallowed too,
 * for the same reason as a vanished row.
 *
 * Deliberately does not revert a `forceTtlRefresh`-driven ttl SET from an
 * earlier committed chunk: the healed anchor is never shorter than what
 * was there before, so leaving it in place after a rollback only means the
 * session's metadata row outlives its content a bit longer than ideal —
 * self-healing (the next successful append, or DynamoDB's own TTL sweep,
 * resolves it), unlike reverting, which would need to re-check for a
 * concurrent legitimate extension to avoid regressing it. See README.md's
 * "TTL expiry" section.
 *
 * Accepts: `delta` — how many messages to subtract; `0` is a no-op and spends
 * no write. `createdBefore` — this call's own append timestamp, which pins the
 * incarnation.
 *
 * Returns: nothing, whether the decrement applied or the guard correctly
 * refused it.
 *
 * Throws: whatever the write throws other than its own condition failure. A
 * vanished row and a newer incarnation are both "nothing of mine to revert",
 * not errors — this runs from an in-progress rollback, where a spurious error
 * for a no-op would misrepresent what happened.
 *
 * Guarantees: the decrement is applied at most once, however often the request
 * is re-sent. `ADD #count :neg` is one of the two writes in this package that
 * are not naturally idempotent — the append's own `ADD #count :n` is the
 * other — and applied twice it subtracts twice, with nothing reading the row
 * back afterwards to notice, so a re-sent attempt must be answered from
 * DynamoDB's idempotency cache rather than re-evaluated. Two things hold
 * that together and only together: the `ClientRequestToken`, which makes a
 * re-send a no-op, and the deadline of {@link MAX_WRITE_LIFETIME_MS}, which
 * stops the retrying while that token is still honoured. Nothing in the token
 * enforces that window — the service honours it for its own ten minutes
 * whatever a caller's retry policy says — so without the deadline a long
 * policy could still be retrying after the window closed, and the re-send
 * would then land as a second subtraction, leaving `messageCount` quietly
 * wrong. `reconcileMessageCount` is the repair if that happens anyway: it
 * recounts the live messages and writes the true total back.
 *
 * The guard is no second line of defence for it. An attempt the condition
 * turns away commits nothing, so DynamoDB caches no result for that attempt's
 * token and a retry is a fresh evaluation rather than a deduplicated one — the
 * exactly-once promise holds for an attempt that **committed**, which is also
 * the only attempt whose re-send could subtract twice.
 */
export async function revertSessionCount(
  context: HistoryContext,
  sessionId: SessionId,
  delta: number,
  createdBefore: string,
): Promise<void> {
  if (delta === 0) return;
  const update = {
    TableName: context.tableName,
    Key: sessionRowKey(sessionId),
    UpdateExpression: 'ADD #count :neg',
    ConditionExpression: `attribute_exists(${PARTITION_KEY_ATTRIBUTE}) AND #c <= :now`,
    ExpressionAttributeNames: { '#count': 'messageCount', '#c': 'createdAt' },
    ExpressionAttributeValues: { ':neg': -delta, ':now': createdBefore },
  };
  const input = { TransactItems: [{ Update: update }], ClientRequestToken: randomUUID() };
  try {
    await withDynamoDBRetry((request) => context.client.transactWrite(input, request), {
      /** Spread, never assigned onto: `context.retry` is the adapter's own object. */
      ...context.retry,
      deadlineAt: nowMs() + MAX_WRITE_LIFETIME_MS,
    });
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
 *
 * Accepts: `total` — every message this call counted onto the row; `0` is a
 * no-op. `createdAt` — this call's timestamp, which is what "I created this
 * row" means here. `title` — the title this call may have contributed.
 *
 * Returns: nothing. The row is deleted, or decremented and stripped of this
 * call's title; both are a complete undo of what this call contributed.
 *
 * Throws: whatever the writes throw other than their own condition failures.
 *
 * Guarantees: the delete is applied at most once, and inside the window its
 * token is honoured for, a re-send of an attempt that **committed** is
 * answered from DynamoDB's idempotency cache rather than re-evaluated. The
 * condition would already stop such a re-send from removing anything it should
 * not; what the token adds is that it comes back as the success it was.
 * Re-evaluated instead, it finds the row gone, fails both equalities, and the
 * cancellation is read below as "a concurrent append has added to this row" —
 * sending a rollback that already completed down the decrement-and-strip path
 * meant for the case where the row survived. Both writes on that path are
 * themselves guarded, and the decrement's incarnation pin refuses a session
 * re-created in the meantime, so the price is two spurious conditional writes
 * rather than a wrong count; the token is what keeps them from being spent.
 *
 * A rejection carries no idempotency forward — a cancelled attempt commits
 * nothing, so nothing is cached for its token — and here that is exactly the
 * wanted behaviour, since the fall-through below is a fresh decision about
 * what to do instead. The deadline drawn beside the token is what keeps the
 * retrying inside that window; the token enforces no window of its own.
 */
export async function revertSessionCreation(
  context: HistoryContext,
  sessionId: SessionId,
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
          Key: sessionRowKey(sessionId),
          ConditionExpression: '#count = :total AND #c = :now',
          ExpressionAttributeNames: { '#count': 'messageCount', '#c': 'createdAt' },
          ExpressionAttributeValues: { ':total': total, ':now': createdAt },
        },
      },
    ],
    ClientRequestToken: randomUUID(),
  };
  try {
    await withDynamoDBRetry((request) => context.client.transactWrite(input, request), {
      ...context.retry,
      /** The delete carries a token too; this is what keeps its retrying inside the window. */
      deadlineAt: nowMs() + MAX_WRITE_LIFETIME_MS,
    });
    return;
  } catch (error) {
    if (!isCancelledByCondition(error as Error)) throw error;
  }
  await revertSessionCount(context, sessionId, total, createdAt);
  if (title !== undefined) await removeRolledBackTitle(context, sessionId, createdAt, title);
}
