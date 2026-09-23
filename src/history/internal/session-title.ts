import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { classifyAwsError } from '../../shared/errors/classify';
import { ErrorCode } from '../../shared/errors/error-code';
import { SESSION_SORT_KEY, sessionPartition } from './keys';
import type { SessionId } from './parse';
import type { HistoryContext } from './setup';

/** True when a plain UpdateItem was turned away by its ConditionExpression. */
function isConditionRejected(error: Error): boolean {
  return classifyAwsError(error) === ErrorCode.CONDITION_CONFLICT;
}

/**
 * Strip a title this call contributed to a session row it created, when the
 * row itself could not be deleted because a concurrent append has since added
 * messages to it.
 *
 * Without this, that narrow window reopens exactly the leak C4 closes: the
 * title is derived from the first human message of an append the caller was
 * told had failed, and `if_not_exists` means nothing ever overwrites it — so
 * a row that now belongs to a different caller keeps up to 80 characters of
 * rolled-back message content.
 *
 * Both guards are load-bearing. `createdAt = :now` establishes that this call
 * created the row, and `title = :title` that the title on it is still the one
 * this call wrote — so a pre-existing title, or one a concurrent caller won
 * the `if_not_exists` race for, is never removed. A condition rejection means
 * exactly that and is not an error; anything else is.
 *
 * Accepts: `createdAt` — this call's own timestamp. `title` — the exact string
 * this call wrote, compared as a value so nothing else's title is removed.
 *
 * Returns: nothing, whether the title was removed or the guards correctly
 * refused.
 *
 * Throws: whatever the update throws other than its own condition failure.
 */
export async function removeRolledBackTitle(
  context: HistoryContext,
  sessionId: SessionId,
  createdAt: string,
  title: string,
): Promise<void> {
  try {
    await withDynamoDBRetry(
      (request) =>
        context.client.update(
          {
            TableName: context.tableName,
            Key: { PK: sessionPartition(sessionId), SK: SESSION_SORT_KEY },
            UpdateExpression: 'REMOVE #title',
            ConditionExpression: '#c = :now AND #title = :title',
            ExpressionAttributeNames: { '#title': 'title', '#c': 'createdAt' },
            ExpressionAttributeValues: { ':now': createdAt, ':title': title },
          },
          request,
        ),
      context.retry,
    );
  } catch (error) {
    if (isConditionRejected(error as Error)) return;
    throw error;
  }
}
