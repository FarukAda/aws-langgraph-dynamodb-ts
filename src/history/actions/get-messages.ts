import {
  type BaseMessage,
  type StoredMessage,
  mapStoredMessagesToChatMessages,
} from '@langchain/core/messages';

import { type CodecDeps, loadPayloadValue, readPayloadBytes } from '../../shared/codec/codec';
import { isPermanentPayloadLoss } from '../../shared/codec/payload-loss';
import { mapWithConcurrency } from '../../shared/concurrency';
import { DEFAULT_READ_CONCURRENCY } from '../../shared/constants';
import { failureLabel } from '../../shared/errors/base-error';
import { toError } from '../../shared/errors/to-error';
import { truncateForLog } from '../../shared/logging/truncate';
import type { CancelOptions } from '../../shared/options';
import { readWindow } from '../internal/message-window';
import { parseGetMessagesRequest, type SessionId } from '../internal/parse';
import type { HistoryContext } from '../internal/setup';
import type { ChatMessageItem, MessageWindow } from '../types';

/** One item's decode outcome: a rebuilt message, or a proof that it never can be. */
type Decoded = { kind: 'ok'; message: BaseMessage } | { kind: 'corrupt'; error: Error };

/**
 * This message's own loss, or the whole read's failure. Only what no reader
 * could ever recover is confined to one message; everything else would hand
 * the caller a silently truncated conversation that
 * `RunnableWithMessageHistory` then re-persists as the truth.
 */
function corruptOrRethrow(error: Error): Decoded {
  if (isPermanentPayloadLoss(error)) return { kind: 'corrupt', error };
  throw error;
}

/**
 * Decode one item in three stages so failures are classified by what caused
 * them. Fetching the bytes (an S3 download, decompression) is infrastructure:
 * a transport, throttling or permission failure there is rethrown. Only a
 * *permanent* loss at that stage — the object is gone, or the decompression
 * guard tripped — is corruption; a row whose `s3Key` lies outside the session's
 * own path is a configuration or tenancy fault, and a payload whose
 * `schemaVersion` is newer than this release reads is a turn a newer reader
 * still serves, so both are rethrown like any other infrastructure failure (see
 * `assertKeyInScope` and `assertReadableDescriptor`).
 *
 * Deserializing is classified the same way, through the same predicate: bytes
 * that are no longer the form the row declares are this message's own loss, but
 * a serde that refuses to reconstruct what intact bytes *name* — the branded
 * refusal {@link loadPayloadValue} raises for a stored `lc` record naming a
 * class outside its allow-list — is a misconfigured serde or a planted row, and
 * is reported for the same reason the out-of-scope key is. Bytes reached this
 * stage bare before it existed, so a refusal of that kind was skipped here
 * while the store and the saver raised on the identical row.
 *
 * Rebuilding the message from what the serde returned is pure data handling, so
 * any failure there — a type LangChain cannot rebuild, such as a
 * `RemoveMessage` — is corruption confined to that one message.
 */
async function decodeMessage(
  context: HistoryContext,
  item: ChatMessageItem,
  sessionId: SessionId,
  signal: AbortSignal | undefined,
): Promise<Decoded> {
  const deps: CodecDeps = {
    serde: context.serde,
    compression: context.compression,
    offloader: context.offloader,
    signal,
  };
  let bytes: Uint8Array;
  try {
    bytes = await readPayloadBytes(item.message, deps, [sessionId]);
  } catch (error) {
    return corruptOrRethrow(error as Error);
  }
  let stored: StoredMessage;
  try {
    stored = await loadPayloadValue<StoredMessage>(item.message.serdeType, bytes, deps);
  } catch (error) {
    return corruptOrRethrow(error as Error);
  }
  try {
    return { kind: 'ok', message: mapStoredMessagesToChatMessages([stored])[0] };
  } catch (error) {
    return { kind: 'corrupt', error: toError(error as Error) };
  }
}

/**
 * Return a session's messages in chronological order — the whole session, or
 * the window `options` selects: `limit` keeps only the newest `limit`
 * messages, `before` only those appended before that instant (see
 * {@link readWindow}). Items past their TTL are filtered out on read
 * (DynamoDB's background TTL sweep can lag by up to 48h), so the returned
 * history is never stale. A corrupt item — see
 * {@link decodeMessage} for exactly what counts — is handled per
 * `onCorruptMessage`: `'throw'` fails the read with the underlying error;
 * `'skip'` (the default) reports it at `error` with its sort key and returns
 * the rest. Every other failure propagates regardless of the policy.
 *
 * Accepts: `options.limit` — the newest N, at least 1; absent asks for the
 * whole session, and `0` is refused rather than read as an empty conversation
 * (see {@link parseMessageWindow}).
 * `options.before` — only messages appended before that instant.
 * `options.signal` — aborts the reads.
 *
 * Returns: the messages in chronological order, oldest first. A session that
 * does not exist and one whose messages have all expired both return nothing:
 * a conversation nobody can read is a conversation that is not there.
 *
 * Throws: `VALIDATION` naming `sessionId`, `limit`, `before`, `signal`, or
 * `options.<key>` for a key this package does not read;
 * `FORMAT_UNSUPPORTED` for a row, or a payload, a newer version wrote — the
 * payload half whatever the policy, because a newer reader reads it and
 * dropping it would lose a turn a rollback could still serve; the decode error
 * of a corrupt row under `onCorruptMessage: 'throw'`; `VALIDATION` naming
 * `message` for a row in this session's message key space that this adapter
 * did not write, naming
 * `s3Key` for a row addressing an object outside the session's own path, and
 * naming `serde` for a row whose payload the serializer refuses to
 * reconstruct, all three whatever the policy; any infrastructure failure — a
 * throttle, a permission, a transport error — whatever the policy, because
 * dropping a message for one of those would hand back a silently truncated
 * conversation that the chain then re-persists as the truth.
 *
 * Guarantees: strongly consistent, so the turn just appended is visible.
 * Offloaded messages download several at a time, and the corruption policy is
 * applied in message order however they finish.
 */
export async function getMessages(
  context: HistoryContext,
  sessionId: string,
  options: MessageWindow & CancelOptions = {},
): Promise<BaseMessage[]> {
  const request = parseGetMessagesRequest(sessionId, options);
  const items: ChatMessageItem[] = await readWindow(
    context,
    request.sessionId,
    request.window,
    request.signal,
  );
  const decoded = await mapWithConcurrency(
    items,
    context.readConcurrency ?? DEFAULT_READ_CONCURRENCY,
    (item) => decodeMessage(context, item, request.sessionId, request.signal),
  );
  const messages: BaseMessage[] = [];
  decoded.forEach((result, index) => {
    if (result.kind === 'ok') {
      messages.push(result.message);
      return;
    }
    if (context.onCorruptMessage === 'throw') throw result.error;
    context.logger.error('getMessages: skipped a corrupt message item', {
      sessionId: request.sessionId,
      sortKey: truncateForLog(items[index].SK),
      reason: truncateForLog(failureLabel(result.error)),
    });
  });
  return messages;
}
