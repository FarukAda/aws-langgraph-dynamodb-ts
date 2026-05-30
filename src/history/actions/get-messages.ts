import {
  type BaseMessage,
  type StoredMessage,
  mapStoredMessagesToChatMessages,
} from '@langchain/core/messages';

import { paginateQuery } from '../../shared/dynamodb/paginate';
import { decodeMessageItem } from '../internal/item-mapper';
import { messageQuery } from '../internal/query';
import type { HistoryContext } from '../internal/setup';
import type { ChatMessageItem } from '../types';

function isExpired(item: ChatMessageItem, nowSeconds: number): boolean {
  return item.ttl !== undefined && item.ttl <= nowSeconds;
}

/**
 * Return a session's messages in chronological order. Items past their TTL are
 * filtered out on read (DynamoDB's background TTL sweep can lag by up to 48h),
 * so the returned history is never stale.
 */
export async function getMessages(
  context: HistoryContext,
  sessionId: string,
): Promise<BaseMessage[]> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const stored: StoredMessage[] = [];
  for await (const raw of paginateQuery({
    client: context.client,
    params: messageQuery(context.tableName, sessionId),
  })) {
    const item = raw as ChatMessageItem;
    if (isExpired(item, nowSeconds)) continue;
    stored.push(await decodeMessageItem(context, item));
  }
  return mapStoredMessagesToChatMessages(stored);
}
