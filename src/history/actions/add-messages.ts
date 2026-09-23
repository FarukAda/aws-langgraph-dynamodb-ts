import type { BaseMessage, StoredMessage } from '@langchain/core/messages';

import { nowIso } from '../../shared/clock';
import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import { appendChunks } from '../internal/append-saga';
import { buildMessageItem } from '../internal/item-mapper';
import { chunkBySize } from '../internal/message-chunker';
import type { HistoryContext } from '../internal/setup';
import { deriveTitle } from '../internal/title-generator';
import { resolveTtlAnchor } from '../internal/ttl-anchor';
import {
  toStoredMessages,
  validateMessageList,
  validateSessionId,
  validateStorableMessages,
} from '../internal/validation';
import type { ChatMessageItem } from '../types';

/** Message Puts per append transaction: the 100-item limit, less the metadata Update. */
const MAX_MESSAGES_PER_TRANSACTION = 99;

/**
 * Aggregate byte budget per transaction. Held ~500 KB below DynamoDB's 4 MB
 * `TransactWriteItems` ceiling so the conservative per-item estimate (see
 * `ITEM_OVERHEAD_BYTES`) cannot push a chunk over the real limit at commit time.
 */
const MAX_TRANSACTION_BYTES = 3_500_000;

/**
 * Encode every message, cleaning up after itself if one fails partway.
 *
 * Offloaded messages upload sequentially here, *before* the append saga's
 * compensation machinery is ever reached, so a failure on message N used to
 * strand messages 1..N-1's already-uploaded S3 objects with no cleanup path —
 * the one gap in this subsystem's otherwise complete no-orphan guarantee.
 * Nothing will ever reference those objects, so they are safe to delete
 * unconditionally on the way out.
 */
async function buildItems(
  context: HistoryContext,
  sessionId: string,
  stored: StoredMessage[],
  ttlTimestamp: number | undefined,
  signal: AbortSignal | undefined,
): Promise<ChatMessageItem[]> {
  const items: ChatMessageItem[] = [];
  try {
    for (const message of stored) {
      items.push(
        await buildMessageItem(context, sessionId, context.ulid(), message, ttlTimestamp, signal),
      );
    }
  } catch (error) {
    if (context.offloader) {
      await cleanUpS3Orphans(
        context.offloader,
        collectS3Keys(items.map((item) => item.message)),
        'history.addMessages.encode',
        context.logger,
      );
    }
    throw error;
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
 *
 * Accepts: `messages` — LangChain messages; an empty list writes nothing and is
 * not an error, which is what a turn that produced no message means.
 * `signal` — aborts between chunks.
 *
 * Returns: nothing, and only once every message has landed.
 *
 * Throws: `VALIDATION` naming `sessionId` or `messages` (with the offending
 * index) before any write; `S3_OFFLOAD_FAILED`; whatever the transaction
 * throws, after the rollback; `COMPENSATION_FAILED` when that
 * rollback could not finish.
 *
 * Guarantees: a caller observes all messages or none. `messageCount` always
 * agrees with the messages that landed, because each chunk writes both in one
 * transaction. Every message of the append shares one creation-anchored expiry,
 * so a conversation expires whole rather than losing its oldest turns first. No
 * S3 object is left behind by a failure, at any stage — including a failure
 * partway through encoding, before the saga exists.
 */
export async function addMessages(
  context: HistoryContext,
  sessionId: string,
  messages: BaseMessage[],
  signal?: AbortSignal,
): Promise<void> {
  validateSessionId(sessionId);
  validateMessageList(messages);
  if (messages.length === 0) return;
  const stored = toStoredMessages(messages);
  validateStorableMessages(stored);
  const anchor = context.ttl
    ? await resolveTtlAnchor(context, sessionId, calculateTtlTimestamp(context.ttl), signal)
    : undefined;
  const items = await buildItems(context, sessionId, stored, anchor?.ttlTimestamp, signal);
  const chunks = chunkBySize(items, MAX_MESSAGES_PER_TRANSACTION, MAX_TRANSACTION_BYTES);
  await appendChunks(
    context,
    sessionId,
    chunks,
    {
      now: nowIso(),
      title: deriveTitle(stored),
      ttlTimestamp: anchor?.ttlTimestamp,
      forceTtlRefresh: anchor?.refresh,
    },
    signal,
  );
}
