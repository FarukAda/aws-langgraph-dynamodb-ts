/**
 * Hides how a session's message key space is read.
 *
 * A read admits only rows this package wrote as a message of this session,
 * refusing any other row in the key space rather than skipping it, treats an
 * expired row as absent however long the sweep lags, walks newest-first when
 * it wants the latest few and restores chronological order, and counts the
 * rows the same way it reads them, so a repaired count is the number a read
 * returns.
 */

import type { NativeAttributeValue } from '@aws-sdk/lib-dynamodb';

import { nowSeconds } from '../../shared/clock';
import { LIST_SCAN_WARN_THRESHOLD } from '../../shared/constants';
import type { DocItem } from '../../shared/dynamodb/client';
import { paginateQuery } from '../../shared/dynamodb/paginate';
import { withDynamoDBRetry, retryFor } from '../../shared/dynamodb/retry';
import { isExpiredRow, assertReadableRow } from '../../shared/dynamodb/table-schema';
import { validationError } from '../../shared/errors/errors';
import { truncateForLog } from '../../shared/logging/truncate';
import { ulidTimePrefix } from '../../shared/ulid';
import type { ParsedWindow, SessionId } from './parse';
import { type ChatMessageItem, messageQuery, messageSortKey, narrowMessageItem } from './rows';
import type { HistoryContext } from './setup';

/**
 * The row as one of this adapter's messages, or a refusal naming it.
 *
 * The version is checked first, so a row a newer release wrote is reported as
 * newer rather than judged against attribute types it may no longer use. What
 * survives that is narrowed rather than cast: a shared table's message key
 * space is this adapter's, and a row in it is not necessarily.
 *
 * Reported and never dropped, whatever `onCorruptMessage` says. That policy
 * exists for a payload no reader could recover, and a row this adapter cannot
 * account for is not one — skipping it handed the caller a shorter
 * conversation that `RunnableWithMessageHistory` then re-persists as the whole
 * truth. The `warn` carries the sort key, cut like every other row-sourced
 * one, because the error can only say that such a row exists and an operator
 * has to go and look at it.
 */
function requireMessageItem(
  context: HistoryContext,
  sessionId: SessionId,
  raw: DocItem,
): ChatMessageItem {
  assertReadableRow(raw, 'message');
  const item = narrowMessageItem(raw);
  if (item) return item;
  context.logger.warn('getMessages: refused a row that is not a chat message item', {
    sessionId,
    sortKey: truncateForLog(raw.SK as string),
  });
  throw validationError(
    'a row in the message key space of this session is not a chat message item this package ' +
      'wrote: its `sessionId` or `message` attribute is absent, is of the wrong type, or names ' +
      'another session. The `warn` logged alongside this names the row',
    'message',
  );
}

/**
 * Read the live message items a window selects, in chronological order.
 *
 * Without `limit` the query walks the session oldest-first. With it the query
 * walks newest-first with a matching page cap and stops as soon as `limit`
 * live items are in hand — rows past their TTL are skipped here, so a page can
 * come back short and the walk simply continues — and the tail is then
 * reversed back into chronological order. `before` becomes an exclusive upper
 * sort-key bound: the message prefix plus the ULID time characters of that
 * instant, which every message id from that millisecond onwards sorts after.
 *
 * Accepts: `window.limit` — absent asks for the whole session, which is what
 * `getMessages()` with no arguments means; otherwise at least 1, which is why
 * no zero case is handled below. `parseMessageWindow` refuses `0` for its
 * own reason, and that refusal is also what keeps `Limit: 0` — which DynamoDB
 * rejects outright with a raw `ValidationException` — out of the query built
 * here. `window.before` — already parsed as a real date. `signal` — aborts
 * between pages.
 *
 * Returns: the live messages in chronological order, oldest first, whichever
 * direction the query walked.
 *
 * Throws: `FORMAT_UNSUPPORTED` for a row a newer version wrote — checked before
 * the row's ttl, so the answer does not depend on the reading machine's clock;
 * `VALIDATION` naming `message` for a row in this session's message key
 * space that this adapter did not write, checked before the ttl for the same
 * reason; `ABORTED`; whatever the query throws.
 *
 * Guarantees: strongly consistent, so the turn just appended is visible to the
 * very next read. An unlimited window is deliberately uncapped — silently
 * truncating a conversation is worse than a slow read, and a caller that wants
 * a bound passes `limit` — so past {@link LIST_SCAN_WARN_THRESHOLD} messages
 * the read still succeeds and an operator is told the session is unusually
 * large.
 */
export async function readWindow(
  context: HistoryContext,
  sessionId: SessionId,
  window: ParsedWindow,
  signal?: AbortSignal,
): Promise<ChatMessageItem[]> {
  const now = nowSeconds();
  const limit = window.limit ?? Number.POSITIVE_INFINITY;
  const items: ChatMessageItem[] = [];
  for await (const raw of paginateQuery({
    retry: retryFor(context, signal),
    signal,
    client: context.client,
    params: messageQuery(context.tableName, sessionId, {
      consistent: true,
      descending: window.limit !== undefined,
      limit: window.limit,
      beforeSortKey: window.before && messageSortKey(ulidTimePrefix(window.before.getTime())),
    }),
    maxItems: Number.POSITIVE_INFINITY,
    maxIterations: Number.POSITIVE_INFINITY,
  })) {
    /**
     * A message newer than this version reads, and a row that is not one of
     * this adapter's at all, both fail loudly rather than vanishing from the
     * window.
     */
    const item = requireMessageItem(context, sessionId, raw);
    if (isExpiredRow(item, now)) continue;
    items.push(item);
    if (items.length >= limit) break;
  }
  if (items.length >= LIST_SCAN_WARN_THRESHOLD) {
    context.logger.warn(
      'getMessages: a session holds very many messages; the read is complete but slow. Pass a ' +
        '`limit` to read only the newest turns',
      { sessionId, messages: items.length },
    );
  }
  return window.limit === undefined ? items : items.reverse();
}

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
function requireCountableRow(raw: DocItem, sessionId: SessionId): ChatMessageItem {
  assertReadableRow(raw, 'message');
  const item = narrowMessageItem(raw);
  if (item) return item;
  throw validationError(
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
 * before the row's ttl as `getMessages` checks it; `VALIDATION` naming
 * `message` for a row in the message key space that is not one of this
 * adapter's, which `getMessages` refuses too; whatever the query throws
 * after retries; `ABORTED`.
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
  sessionId: SessionId,
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
