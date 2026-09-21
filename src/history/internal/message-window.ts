import { nowSeconds } from '../../shared/clock';
import { LIST_SCAN_WARN_THRESHOLD } from '../../shared/constants';
import { isExpiredRow } from '../../shared/dynamodb/expiry';
import { paginateQuery } from '../../shared/dynamodb/paginate';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { assertReadableRow } from '../../shared/dynamodb/row-version';
import type { CancelOptions } from '../../shared/options';
import { ulidTimePrefix } from '../../shared/ulid';
import type { ChatMessageItem, MessageWindow } from '../types';
import { messageSortKey } from './keys';
import { messageQuery } from './query';
import type { HistoryContext } from './setup';

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
 * `AbortError`; whatever the query throws.
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
    const item = raw as ChatMessageItem;
    /** A message newer than this version reads fails loudly rather than vanishing from the window. */
    assertReadableRow(item, 'message');
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
