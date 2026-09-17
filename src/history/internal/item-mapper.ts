import type { StoredMessage } from '@langchain/core/messages';

import { type CodecDeps } from '../../shared/codec/codec';
import { encodePayload } from '../../shared/codec/encode';
import { ROW_FORMAT_VERSION } from '../../shared/dynamodb/row-version';
import type { ChatMessageItem } from '../types';
import { messageSortKey, sessionPartition } from './keys';
import type { HistoryContext } from './setup';

function codecDeps(context: HistoryContext): CodecDeps {
  return { serde: context.serde, compression: context.compression, offloader: context.offloader };
}

/**
 * Encode a single stored message into its DynamoDB item.
 *
 * Accepts: `ulid` — the message's own id, which orders it and names its
 * offloaded object; the caller allocates one per message from a monotonic
 * factory. `ttlTimestamp` — the uniform whole-conversation expiry every
 * message in the session shares, so a conversation expires as one thing rather
 * than losing its oldest turns first.
 *
 * Returns: the row, keyed by the session partition and a `MSG#<ulid>` sort key,
 * its payload inline or offloaded to `<keyPrefix><sessionId, base64url>/<ulid>.bin`.
 *
 * Throws: ValidationError naming `value` for a message the serializer cannot
 * represent; `S3_OFFLOAD_FAILED` when an offloaded payload cannot be uploaded.
 * Encoding precedes the transaction, so a message that cannot be stored never
 * half-writes a turn.
 */
export async function buildMessageItem(
  context: HistoryContext,
  sessionId: string,
  ulid: string,
  message: StoredMessage,
  ttlTimestamp?: number,
): Promise<ChatMessageItem> {
  const pk = sessionPartition(sessionId);
  const sk = messageSortKey(ulid);
  const descriptor = await encodePayload(message, codecDeps(context), {
    keyParts: [sessionId],
    objectId: ulid,
    row: { pk, sk },
  });
  const item: ChatMessageItem = {
    PK: pk,
    SK: sk,
    v: ROW_FORMAT_VERSION,
    sessionId,
    message: descriptor,
  };
  if (ttlTimestamp !== undefined) item.ttl = ttlTimestamp;
  return item;
}
