import {
  type BaseMessage,
  type StoredMessage,
  mapChatMessagesToStoredMessages,
} from '@langchain/core/messages';

import { nowIso } from '../../shared/clock';
import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { batchWriteAll } from '../../shared/dynamodb/batch-write';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { validateNonEmptyString } from '../../shared/validation/primitives';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import { buildMessageItem } from '../internal/item-mapper';
import { buildSessionUpdate } from '../internal/session-update';
import type { HistoryContext } from '../internal/setup';
import { deriveTitle } from '../internal/title-generator';
import type { ChatMessageItem } from '../types';

async function buildItems(
  context: HistoryContext,
  sessionId: string,
  stored: StoredMessage[],
  ttlTimestamp?: number,
): Promise<ChatMessageItem[]> {
  const items: ChatMessageItem[] = [];
  for (const message of stored) {
    items.push(await buildMessageItem(context, sessionId, context.ulid(), message, ttlTimestamp));
  }
  return items;
}

/**
 * Append messages with an O(1) write: one item per message via a single batched
 * put, then one atomic `ADD` update of the session-metadata item. There is no
 * read-modify-write, so concurrent appends never clobber each other, and the
 * uniform whole-conversation TTL keeps a live session free of mid-history gaps.
 */
export async function addMessages(
  context: HistoryContext,
  sessionId: string,
  messages: BaseMessage[],
): Promise<void> {
  validateNonEmptyString(sessionId, 'sessionId');
  if (messages.length === 0) return;
  const stored = mapChatMessagesToStoredMessages(messages);
  const now = nowIso();
  const ttlTimestamp = context.ttl ? calculateTtlTimestamp(context.ttl) : undefined;
  const items = await buildItems(context, sessionId, stored, ttlTimestamp);
  try {
    await batchWriteAll(
      context.client,
      context.tableName,
      items.map((item) => ({ PutRequest: { Item: item } })),
    );
  } catch (error) {
    if (context.offloader) {
      await cleanUpS3Orphans(
        context.offloader,
        collectS3Keys(items.map((item) => item.message)),
        'history.addMessages',
        context.logger,
      );
    }
    throw error;
  }
  await withDynamoDBRetry(() =>
    context.client.update(
      buildSessionUpdate(context.tableName, {
        sessionId,
        count: stored.length,
        now,
        title: deriveTitle(stored),
        ttlTimestamp,
      }),
    ),
  );
}
