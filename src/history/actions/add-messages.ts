import {
  type BaseMessage,
  type StoredMessage,
  mapChatMessagesToStoredMessages,
} from '@langchain/core/messages';

import { nowIso } from '../../shared/clock';
import { validateNonEmptyString } from '../../shared/validation/primitives';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import { appendChunks } from '../internal/append-saga';
import { buildMessageItem } from '../internal/item-mapper';
import { chunkBySize } from '../internal/message-chunker';
import type { HistoryContext } from '../internal/setup';
import { deriveTitle } from '../internal/title-generator';
import { resolveTtlAnchor } from '../internal/ttl-anchor';
import type { ChatMessageItem } from '../types';

/** Message Puts per append transaction: the 100-item limit, less the metadata Update. */
const MAX_MESSAGES_PER_TRANSACTION = 99;

/**
 * Aggregate byte budget per transaction. Held ~500 KB below DynamoDB's 4 MB
 * `TransactWriteItems` ceiling so the conservative per-item estimate (see
 * `ITEM_OVERHEAD_BYTES`) cannot push a chunk over the real limit at commit time.
 */
const MAX_TRANSACTION_BYTES = 3_500_000;

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
 * Append messages as one item per message. Each chunk writes its message Puts
 * and the session-metadata count `ADD` in a single `TransactWriteItems`, so
 * `messageCount` can never disagree with the stored messages. A creation-anchored
 * TTL (resolved by read, set in the transaction via `if_not_exists`) gives every
 * item one shared expiry. Batches larger than the 100-item / 4 MB transaction
 * limits are split into chunks and applied with caller-observed atomicity: if a
 * later chunk fails, the committed chunks are rolled back (see {@link appendChunks}).
 *
 * Per item the 400 KB DynamoDB limit still applies; enable S3 offloading so
 * large payloads become small descriptors and stay well under the limits.
 */
export async function addMessages(
  context: HistoryContext,
  sessionId: string,
  messages: BaseMessage[],
): Promise<void> {
  validateNonEmptyString(sessionId, 'sessionId');
  if (messages.length === 0) return;
  const stored = mapChatMessagesToStoredMessages(messages);
  const anchor = context.ttl
    ? await resolveTtlAnchor(context, sessionId, calculateTtlTimestamp(context.ttl))
    : undefined;
  const items = await buildItems(context, sessionId, stored, anchor?.ttlTimestamp);
  const chunks = chunkBySize(items, MAX_MESSAGES_PER_TRANSACTION, MAX_TRANSACTION_BYTES);
  await appendChunks(context, sessionId, chunks, {
    now: nowIso(),
    title: deriveTitle(stored),
    ttlTimestamp: anchor?.ttlTimestamp,
    forceTtlRefresh: anchor?.refresh,
  });
}
