import type { NativeAttributeValue } from '@aws-sdk/lib-dynamodb';

import { nowSeconds } from '../../shared/clock';
import { isExpiredRow } from '../../shared/dynamodb/expiry';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { assertReadableRow } from '../../shared/dynamodb/row-version';
import type { DocItem } from '../../shared/dynamodb/types';
import { ValidationError } from '../../shared/errors/errors';
import type { ChatMessageItem } from '../types';
import { narrowMessageItem } from './item-mapper';
import { messageQuery } from './query';
import type { HistoryContext } from './setup';

/**
 * The row as one of this session's messages, or a refusal naming it — the same
 * test the read makes, on the same order: the version first, so a row a newer
 * release wrote is reported as newer rather than judged against attribute
 * types it may no longer use.
 *
 * The count is a definition rather than a tally, and the definition is "what
 * `getMessages` would return". A row in the message key space that this
 * adapter did not write makes that read refuse the whole session, so counting
 * it would write a repaired `messageCount` back onto a session no reader can
 * open — a number that is not merely stale but describes nothing. The repair
 * refuses instead, and the read's own `warn` is what names the row.
 */
function requireCountableRow(raw: DocItem, sessionId: string): ChatMessageItem {
  assertReadableRow(raw as ChatMessageItem, 'message');
  const item = narrowMessageItem(raw);
  if (item) return item;
  throw new ValidationError(
    `session "${sessionId}" holds a row in its message key space that is not a chat message ` +
      'item this package wrote, so its messages cannot be counted: a read of the session ' +
      'reports the same row and names it. Remove or repair the row, then reconcile again',
    'message',
  );
}

/**
 * The number of message rows a session holds, counted the way the read path
 * counts them.
 *
 * Only rows `getMessages` would return are counted: an expired message that
 * DynamoDB's TTL sweep has not yet removed is invisible to every reader, so
 * counting it would "repair" `messageCount` to a number nobody ever sees. The
 * count is therefore a definition, not an implementation detail — it is what
 * makes the repaired value agree with what the session returns. For the same
 * reason a message a newer release wrote, and a row in the message key space
 * that this adapter did not write, are both refused rather than counted:
 * `getMessages` refuses them.
 *
 * Accepts: `sessionId` — validated by the caller. `signal` — aborts the reads.
 *
 * Returns: how many messages a reader would actually see right now.
 *
 * Throws: `FORMAT_UNSUPPORTED` for a message row a newer release wrote, checked
 * before the row's ttl as `getMessages` checks it; ValidationError naming
 * `message` for a row in the message key space that is not one of this
 * adapter's, which `getMessages` refuses too; whatever the query throws
 * after retries; `AbortError`.
 *
 * Guarantees: each row comes back projected to its identity, its format
 * version and its ttl, so no message payload is transferred however large the
 * session is — the descriptor is projected by the one nested path
 * `message.location` that every descriptor this package has written carries,
 * which proves the attribute is there and a map without reading the bytes it
 * holds. Every check runs here rather than in a filter, because a filter would
 * drop an expired row before its version could be checked. The paging is
 * deliberately uncapped: a partial count is not a repair, it is a new and
 * wrong number, so the count either completes or fails.
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
    ProjectionExpression: '#pk, #sid, #msg.#loc, #v, #ttl',
    ExpressionAttributeNames: {
      ...query.ExpressionAttributeNames,
      '#sid': 'sessionId',
      '#msg': 'message',
      '#loc': 'location',
      '#v': 'v',
      '#ttl': 'ttl',
    },
  };
  let total = 0;
  let startKey: Record<string, NativeAttributeValue> | undefined;
  do {
    const page = await withDynamoDBRetry(
      (request) => context.client.query({ ...base, ExclusiveStartKey: startKey }, request),
      retryFor(context, signal),
    );
    for (const raw of page.Items ?? []) {
      const row = requireCountableRow(raw, sessionId);
      if (!isExpiredRow(row, now)) total += 1;
    }
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return total;
}
