import { nowSeconds } from '../../shared/clock';
import { isExpiredRow } from '../../shared/dynamodb/expiry';
import { paginateQuery } from '../../shared/dynamodb/paginate';
import { retryFor } from '../../shared/dynamodb/retry-policy';
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
 * Reads are strongly consistent so the turn just appended is visible to the
 * very next read.
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
    if (isExpiredRow(item, now)) continue;
    items.push(item);
    if (items.length >= limit) break;
  }
  return options.limit === undefined ? items : items.reverse();
}
