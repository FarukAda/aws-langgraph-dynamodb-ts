import type { StoredMessage } from '@langchain/core/messages';

import { type CodecDeps, encodePayload } from '../../shared/codec/codec';
import type { ChatMessageItem } from '../types';
import { messageSortKey, sessionPartition } from './keys';
import type { HistoryContext } from './setup';

function codecDeps(context: HistoryContext): CodecDeps {
  return { serde: context.serde, compression: context.compression, offloader: context.offloader };
}

/**
 * Encode a single stored message into its DynamoDB item, keyed by the session
 * partition and a `MSG#<ulid>` sort key. A `ttlTimestamp` stamps the uniform
 * whole-conversation expiry shared by every message in the session.
 */
export async function buildMessageItem(
  context: HistoryContext,
  sessionId: string,
  ulid: string,
  message: StoredMessage,
  ttlTimestamp?: number,
): Promise<ChatMessageItem> {
  const descriptor = await encodePayload(message, codecDeps(context), {
    keyParts: [sessionId, ulid],
  });
  const item: ChatMessageItem = {
    PK: sessionPartition(sessionId),
    SK: messageSortKey(ulid),
    sessionId,
    message: descriptor,
  };
  if (ttlTimestamp !== undefined) item.ttl = ttlTimestamp;
  return item;
}
