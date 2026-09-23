import { nowSeconds } from '../../shared/clock';
import { LIST_SCAN_WARN_THRESHOLD } from '../../shared/constants';
import { isExpiredRow } from '../../shared/dynamodb/expiry';
import { paginateQuery } from '../../shared/dynamodb/paginate';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { assertReadableRow } from '../../shared/dynamodb/row-version';
import type { DocItem } from '../../shared/dynamodb/types';
import { validationError } from '../../shared/errors/errors';
import { truncateForLog } from '../../shared/logging/truncate';
import type { CancelOptions } from '../../shared/options';
import { ulidTimePrefix } from '../../shared/ulid';
import type { ChatMessageItem, MessageWindow } from '../types';
import { narrowMessageItem } from './item-mapper';
import { messageSortKey } from './keys';
import { messageQuery } from './query';
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
  sessionId: string,
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
 * Accepts: `options.limit` — absent asks for the whole session, which is what
 * `getMessages()` with no arguments means; otherwise at least 1, which is why
 * no zero case is handled below. `validateMessageWindow` refuses `0` for its
 * own reason, and that refusal is also what keeps `Limit: 0` — which DynamoDB
 * rejects outright with a raw `ValidationException` — out of the query built
 * here. `options.before` — already validated as a real date. `options.signal`
 * — aborts between pages.
 *
 * Returns: the live messages in chronological order, oldest first, whichever
 * direction the query walked.
 *
 * Throws: `FORMAT_UNSUPPORTED` for a row a newer version wrote — checked before
 * the row's ttl, so the answer does not depend on the reading machine's clock;
 * ValidationError naming `message` for a row in this session's message key
 * space that this adapter did not write, checked before the ttl for the same
 * reason; `AbortError`; whatever the query throws.
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
  sessionId: string,
  options: MessageWindow & CancelOptions,
): Promise<ChatMessageItem[]> {
  const now = nowSeconds();
  const limit = options.limit ?? Number.POSITIVE_INFINITY;
  const items: ChatMessageItem[] = [];
  for await (const raw of paginateQuery({
    retry: retryFor(context, options.signal),
    signal: options.signal,
    client: context.client,
    params: messageQuery(context.tableName, sessionId, {
      consistent: true,
      descending: options.limit !== undefined,
      limit: options.limit,
      beforeSortKey: options.before && messageSortKey(ulidTimePrefix(options.before.getTime())),
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
  return options.limit === undefined ? items : items.reverse();
}
