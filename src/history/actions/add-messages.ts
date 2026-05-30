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
 * Append messages as one item per message. The session-metadata item is updated
 * first with `ReturnValues: ALL_NEW`, which atomically establishes and reads
 * back the creation-anchored TTL: `if_not_exists` makes every caller — including
 * simultaneous first appends — observe the same anchor, with no race. Each
 * message item is then stamped with that anchor, so the whole conversation
 * expires together with no mid-history gaps.
 */
export async function addMessages(
  context: HistoryContext,
  sessionId: string,
  messages: BaseMessage[],
): Promise<void> {
  validateNonEmptyString(sessionId, 'sessionId');
  if (messages.length === 0) return;
  const stored = mapChatMessagesToStoredMessages(messages);
  const candidateTtl = context.ttl ? calculateTtlTimestamp(context.ttl) : undefined;
  const updated = await withDynamoDBRetry(() =>
    context.client.update(
      buildSessionUpdate(context.tableName, {
        sessionId,
        count: stored.length,
        now: nowIso(),
        title: deriveTitle(stored),
        ttlTimestamp: candidateTtl,
      }),
    ),
  );
  const ttlTimestamp = candidateTtl
    ? (updated.Attributes as { ttl?: number } | undefined)?.ttl
    : undefined;
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
}
