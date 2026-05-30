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
import { chunkBySize } from '../internal/message-chunker';
import { writeMessageChunk } from '../internal/message-transaction';
import type { HistoryContext } from '../internal/setup';
import { deriveTitle } from '../internal/title-generator';
import { resolveTtlAnchor } from '../internal/ttl-anchor';
import type { ChatMessageItem } from '../types';

/** Message Puts per append transaction: the 100-item limit, less the metadata Update. */
const MAX_MESSAGES_PER_TRANSACTION = 99;

/** Aggregate byte budget per transaction, kept under the 4 MB DynamoDB limit. */
const MAX_TRANSACTION_BYTES = 3_500_000;

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
  chunks: ChatMessageItem[][],
  index: number,
  append: AppendContext,
): Promise<void> {
  const chunk = chunks[index];
  try {
    await writeMessageChunk(context, chunk, {
      sessionId,
      count: chunk.length,
      now: append.now,
      title: append.title,
      ttlTimestamp: append.ttlTimestamp,
    });
  } catch (error) {
    if (context.offloader) {
      const uncommitted = chunks.slice(index).flat();
      await cleanUpS3Orphans(
        context.offloader,
        collectS3Keys(uncommitted.map((item) => item.message)),
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
 * write so every item shares one expiry. Appends are split into successive
 * atomic chunks bounded by both the 100-item and 4 MB transaction limits; an
 * earlier chunk that already committed is never cleaned up on a later failure.
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
  const append: AppendContext = {
    now: nowIso(),
    title: deriveTitle(stored),
    ttlTimestamp: context.ttl
      ? await resolveTtlAnchor(context, sessionId, calculateTtlTimestamp(context.ttl))
      : undefined,
  };
  const items = await buildItems(context, sessionId, stored, append.ttlTimestamp);
  const chunks = chunkBySize(items, MAX_MESSAGES_PER_TRANSACTION, MAX_TRANSACTION_BYTES);
  for (let index = 0; index < chunks.length; index++) {
    await flushChunk(context, sessionId, chunks, index, append);
  }
}
