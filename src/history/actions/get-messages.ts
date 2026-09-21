import {
  type BaseMessage,
  type StoredMessage,
  mapStoredMessagesToChatMessages,
} from '@langchain/core/messages';

import { type CodecDeps, readPayloadBytes } from '../../shared/codec/codec';
import { isPermanentPayloadLoss } from '../../shared/codec/payload-loss';
import { mapWithConcurrency } from '../../shared/concurrency';
import { DEFAULT_READ_CONCURRENCY } from '../../shared/constants';
import { toError } from '../../shared/errors/wrap-error';
import type { CancelOptions } from '../../shared/options';
import { assertSignalLike } from '../../shared/validation/collaborators';
import { GET_MESSAGES_KEYS } from '../../shared/validation/method-keys';
import { assertShape } from '../../shared/validation/option-shape';
import { readWindow } from '../internal/message-window';
import type { HistoryContext } from '../internal/setup';
import { validateMessageWindow, validateSessionId } from '../internal/validation';
import type { ChatMessageItem, MessageWindow } from '../types';

/** One item's decode outcome: a rebuilt message, or a proof that it never can be. */
type Decoded = { kind: 'ok'; message: BaseMessage } | { kind: 'corrupt'; error: Error };

/**
 * Decode one item in two stages so failures are classified by what caused
 * them. Fetching the bytes (an S3 download, decompression) is infrastructure:
 * a transport, throttling or permission failure there is rethrown, because
 * dropping the message would hand the caller a silently truncated conversation
 * that `RunnableWithMessageHistory` then re-persists. Only a *permanent* loss
 * at that stage — the object is gone, or the decompression guard tripped — is
 * corruption. Deserializing and rebuilding the message is pure data handling,
 * so any failure there (bad bytes, a type LangChain cannot rebuild such as a
 * `RemoveMessage`) is corruption too, and is confined to that one message.
 */
async function decodeMessage(
  context: HistoryContext,
  item: ChatMessageItem,
  sessionId: string,
): Promise<Decoded> {
  const deps: CodecDeps = {
    serde: context.serde,
    compression: context.compression,
    offloader: context.offloader,
  };
  let bytes: Uint8Array;
  try {
    bytes = await readPayloadBytes(item.message, deps, [sessionId]);
  } catch (error) {
    if (isPermanentPayloadLoss(error as Error)) return { kind: 'corrupt', error: error as Error };
    throw error;
  }
  try {
    const stored = (await context.serde.loadsTyped(item.message.serdeType, bytes)) as StoredMessage;
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
 * (see {@link validateMessageWindow}).
 * `options.before` — only messages appended before that instant.
 * `options.signal` — aborts the reads.
 *
 * Returns: the messages in chronological order, oldest first. A session that
 * does not exist and one whose messages have all expired both return nothing:
 * a conversation nobody can read is a conversation that is not there.
 *
 * Throws: ValidationError naming `sessionId`, `limit`, `before`, `signal`, or
 * `options.<key>` for a key this package does not read;
 * `FORMAT_UNSUPPORTED` for a row a newer version wrote; the decode error of a
 * corrupt row under `onCorruptMessage: 'throw'`; any infrastructure failure —
 * a throttle, a permission, a transport error — whatever the policy, because
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
  assertShape(options, GET_MESSAGES_KEYS, 'options');
  assertSignalLike(options.signal);
  validateSessionId(sessionId);
  validateMessageWindow(options);
  const items: ChatMessageItem[] = await readWindow(context, sessionId, options);
  /** Offloaded rows cost one S3 GET each, so they decode several at a time; the policy is applied in order. */
  const decoded = await mapWithConcurrency(
    items,
    context.readConcurrency ?? DEFAULT_READ_CONCURRENCY,
    (item) => decodeMessage(context, item, sessionId),
  );
  const messages: BaseMessage[] = [];
  decoded.forEach((result, index) => {
    if (result.kind === 'ok') {
      messages.push(result.message);
      return;
    }
    if (context.onCorruptMessage === 'throw') throw result.error;
    context.logger.error('getMessages: skipped a corrupt message item', {
      sessionId,
      sortKey: items[index].SK,
      reason: result.error.name,
    });
  });
  return messages;
}
