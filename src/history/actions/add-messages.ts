import {
  type BaseMessage,
  type StoredMessage,
  mapChatMessagesToStoredMessages,
} from '@langchain/core/messages';

import { nowIso } from '../../shared/clock';
import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { validateNonEmptyString } from '../../shared/validation/primitives';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import { buildMessageItem } from '../internal/item-mapper';
import { writeMessageChunk } from '../internal/message-transaction';
import type { HistoryContext } from '../internal/setup';
import { deriveTitle } from '../internal/title-generator';
import { establishTtlAnchor } from '../internal/ttl-anchor';
import type { ChatMessageItem } from '../types';

/** Message Puts per append transaction: the 100-item limit, less the metadata Update. */
const MAX_MESSAGES_PER_TRANSACTION = 99;

/** Shared per-append values applied to every chunk. */
interface AppendContext {
  now: string;
  title?: string;
  ttlTimestamp?: number;
}

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

async function flushChunk(
  context: HistoryContext,
  sessionId: string,
  chunk: StoredMessage[],
  append: AppendContext,
): Promise<void> {
  const items = await buildItems(context, sessionId, chunk, append.ttlTimestamp);
  try {
    await writeMessageChunk(context, items, {
      sessionId,
      count: chunk.length,
      now: append.now,
      title: append.title,
    });
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

/**
 * Append messages as one item per message. The message Puts and the
 * session-metadata count `ADD` are written together in a single
 * `TransactWriteItems`, so `messageCount` can never disagree with the stored
 * messages. The creation-anchored TTL is established once via a conditional
 * write so every item shares one expiry. Appends past the 100-item transaction
 * limit are split into successive atomic chunks.
 *
 * Each chunk is bound by the DynamoDB transaction limits (100 items, 4 MB
 * aggregate, 400 KB per item). For large payloads, enable S3 offloading so each
 * item stays a small descriptor and the aggregate limit is not reached.
 */
export async function addMessages(
  context: HistoryContext,
  sessionId: string,
  messages: BaseMessage[],
): Promise<void> {
  validateNonEmptyString(sessionId, 'sessionId');
  if (messages.length === 0) return;
  const stored = mapChatMessagesToStoredMessages(messages);
  const append: AppendContext = {
    now: nowIso(),
    title: deriveTitle(stored),
    ttlTimestamp: context.ttl
      ? await establishTtlAnchor(context, sessionId, calculateTtlTimestamp(context.ttl))
      : undefined,
  };
  for (let start = 0; start < stored.length; start += MAX_MESSAGES_PER_TRANSACTION) {
    const chunk = stored.slice(start, start + MAX_MESSAGES_PER_TRANSACTION);
    await flushChunk(context, sessionId, chunk, append);
  }
}
