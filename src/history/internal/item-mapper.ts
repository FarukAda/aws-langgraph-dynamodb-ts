import type { StoredMessage } from '@langchain/core/messages';

import { type CodecDeps } from '../../shared/codec/codec';
import { encodePayload } from '../../shared/codec/encode';
import type { DocItem } from '../../shared/dynamodb/client';
import { ROW_FORMAT_VERSION } from '../../shared/dynamodb/table-schema';
import type { ChatMessageItem } from '../types';
import { messageSortKey, sessionPartition } from './keys';
import type { SessionId } from './parse';
import type { HistoryContext } from './setup';

function codecDeps(context: HistoryContext, signal?: AbortSignal): CodecDeps {
  return {
    serde: context.serde,
    compression: context.compression,
    offloader: context.offloader,
    signal,
  };
}

/**
 * Encode a single stored message into its DynamoDB item.
 *
 * Accepts: `ulid` — the message's own id, which orders it and names its
 * offloaded object; the caller allocates one per message from a monotonic
 * factory. `ttlTimestamp` — the uniform whole-conversation expiry every
 * message in the session shares, so a conversation expires as one thing rather
 * than losing its oldest turns first. `signal` — cancels the upload an
 * offloaded message costs.
 *
 * Returns: the row, keyed by the session partition and a `MSG#<ulid>` sort key,
 * its payload inline or offloaded to `<keyPrefix><sessionId, base64url>/<ulid>.bin`.
 *
 * Throws: `VALIDATION` naming `value` for a message the serializer cannot
 * represent; `S3_OFFLOAD_FAILED` when an offloaded payload cannot be uploaded.
 * Encoding precedes the transaction, so a message that cannot be stored never
 * half-writes a turn.
 */
export async function buildMessageItem(
  context: HistoryContext,
  sessionId: SessionId,
  ulid: string,
  message: StoredMessage,
  ttlTimestamp?: number,
  signal?: AbortSignal,
): Promise<ChatMessageItem> {
  const pk = sessionPartition(sessionId);
  const sk = messageSortKey(ulid);
  const descriptor = await encodePayload(message, codecDeps(context, signal), {
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

/**
 * Narrow a raw row to a {@link ChatMessageItem}.
 *
 * Accepts: `raw` — any row read from a session's partition under the message
 * sort-key prefix, which on a shared table another writer can produce too.
 *
 * Returns: the item, or undefined for a row that merely shares the prefix —
 * one carrying no `sessionId`, no `message` descriptor, or a `sessionId` that
 * disagrees with the partition it was found in. The test is on the attributes
 * a message must have, not on a cast: this is the one boundary where a row may
 * not have been written by this adapter, and the read used to trust the key it
 * was found at. A `message` of `null` is refused here, as
 * `narrowMetaItem` refuses a `metadata` of `null`.
 *
 * Throws: nothing; a row a newer release wrote is the caller's to refuse,
 * before the shape is judged against attribute types that release may no
 * longer use.
 *
 * Guarantees: a row's attributes are bound to the partition it lives in, so a
 * row planted under one session cannot claim to belong to another.
 */
export function narrowMessageItem(raw: DocItem): ChatMessageItem | undefined {
  const shaped =
    typeof raw.sessionId === 'string' && typeof raw.message === 'object' && raw.message !== null;
  if (!shaped) return undefined;
  const item = raw as ChatMessageItem;
  return item.PK === sessionPartition(item.sessionId) ? item : undefined;
}
