import {
  type BaseMessage,
  type StoredMessage,
  mapStoredMessagesToChatMessages,
} from '@langchain/core/messages';

import { paginateQuery } from '../../shared/dynamodb/paginate';
import { decodeMessageItem } from '../internal/item-mapper';
import { messageQuery } from '../internal/query';
import type { HistoryContext } from '../internal/setup';
import { validateSessionId } from '../internal/validation';
import type { ChatMessageItem } from '../types';

function isExpired(item: ChatMessageItem, nowSeconds: number): boolean {
  return item.ttl !== undefined && item.ttl <= nowSeconds;
}

/**
 * Decode one item, honouring the configured corrupt-message policy. Under the
 * default `'skip'` an undecodable item is reported and dropped rather than
 * taking the whole session down with it: one bad row used to throw out of
 * `getMessages` entirely, making every other message in the session
 * permanently unreadable with no API to remove just the bad one.
 */
async function decodeOrSkip(
  context: HistoryContext,
  sessionId: string,
  item: ChatMessageItem,
): Promise<StoredMessage | undefined> {
  try {
    return await decodeMessageItem(context, item);
  } catch (error) {
    if (context.onCorruptMessage === 'throw') throw error;
    context.logger.error('getMessages: skipped a corrupt message item', {
      sessionId,
      sortKey: item.SK,
    });
    return undefined;
  }
}

/**
 * Return a session's messages in chronological order. Items past their TTL are
 * filtered out on read (DynamoDB's background TTL sweep can lag by up to 48h),
 * so the returned history is never stale. An item that cannot be decoded is
 * handled per `onCorruptMessage` (see {@link decodeOrSkip}).
 */
export async function getMessages(
  context: HistoryContext,
  sessionId: string,
): Promise<BaseMessage[]> {
  validateSessionId(sessionId);
  const nowSeconds = Math.floor(Date.now() / 1000);
  const stored: StoredMessage[] = [];
  for await (const raw of paginateQuery({
    client: context.client,
    params: messageQuery(context.tableName, sessionId),
    maxItems: Number.POSITIVE_INFINITY,
    maxIterations: Number.POSITIVE_INFINITY,
  })) {
    const item = raw as ChatMessageItem;
    if (isExpired(item, nowSeconds)) continue;
    const message = await decodeOrSkip(context, sessionId, item);
    if (message) stored.push(message);
  }
  return mapStoredMessagesToChatMessages(stored);
}
