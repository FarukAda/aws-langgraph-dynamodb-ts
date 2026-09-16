import {
  type BaseMessage,
  type StoredMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
} from '@langchain/core/messages';

import { MAX_PARTITION_ID_BYTES } from '../../shared/constants';
import { ValidationError } from '../../shared/errors/errors';
import { validateIdentifier, validateInteger } from '../../shared/validation/primitives';
import type { MessageWindow } from '../types';
import { SORT_KEY_SEPARATOR } from './keys';

/**
 * Validate a session id as the partition key it becomes.
 *
 * Accepts: `sessionId` — non-blank, free of the sort-key separator and of
 * control characters, at most {@link MAX_PARTITION_ID_BYTES}.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `sessionId`.
 *
 * Guarantees: applied on every entry point, not just the write path. A bad
 * value used to reach DynamoDB and surface as a raw AWS SDK exception on reads
 * while the identical value threw this library's typed error on a write.
 */
export function validateSessionId(sessionId: string): void {
  validateIdentifier(sessionId, SORT_KEY_SEPARATOR, 'sessionId', MAX_PARTITION_ID_BYTES);
}

/**
 * Serialize the caller's messages, reporting a value that is not a message.
 *
 * Accepts: `messages` — LangChain messages. The type says so; this runs for the
 * JavaScript caller it does not bind, and for the `any` that reaches an
 * `addMessages` through a chain. Empty is empty.
 *
 * Returns: the messages in their stored form, in order.
 *
 * Throws: ValidationError naming `messages` and the offending index. Serializing
 * one message at a time is what makes that index knowable: mapping the array in
 * one call failed with `TypeError: message.toDict is not a function` from inside
 * LangChain, naming neither the message nor this library.
 */
export function toStoredMessages(messages: BaseMessage[]): StoredMessage[] {
  return messages.map((message, index) => {
    try {
      return mapChatMessagesToStoredMessages([message])[0];
    } catch (error) {
      throw new ValidationError(
        `messages[${index}] is not a LangChain message: ${(error as Error).message}`,
        'messages',
      );
    }
  });
}

/**
 * Reject a message this adapter could never read back.
 *
 * Accepts: `stored` — the messages as LangChain serializes them; empty is
 * valid. The check *is* the read side's own rebuild
 * (`mapStoredMessagesToChatMessages`), so write and read agree by construction
 * rather than by two lists of types kept in step by hand.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `messages`, carrying the offending index and
 * type. A `RemoveMessage`, or a tool, function or generic message missing its
 * required field, fails here instead of being persisted and then skipped or
 * thrown by `getMessages`.
 */
export function validateStorableMessages(stored: StoredMessage[]): void {
  stored.forEach((message, index) => {
    try {
      mapStoredMessagesToChatMessages([message]);
    } catch (error) {
      throw new ValidationError(
        `messages[${index}] of type "${message.type}" cannot be stored: ${(error as Error).message}`,
        'messages',
      );
    }
  });
}

/**
 * Validate a `getMessages` window.
 *
 * Accepts: `limit` — absent asks for the whole session; otherwise a positive
 * integer. `0` is refused rather than answered with nothing: for a window into
 * a conversation it is far more likely a bug than a request. `before` —
 * absent means up to now; otherwise a `Date` whose time is finite. `null` is
 * refused, naming `before`, rather than read as "up to now". A `Date` is
 * duck-typed, since one from another realm is still a date.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `limit` or `before`, before any DynamoDB
 * call. `before: null` used to reach `null.getTime`, a property access the
 * boundary branded `UpstreamError` instead of naming the caller's mistake; an
 * invalid `Date` would otherwise derive a NaN sort key that matches nothing
 * and read as an empty conversation.
 */
export function validateMessageWindow(window: MessageWindow): void {
  if (window.limit !== undefined) validateInteger(window.limit, 'limit', { min: 1 });
  if (window.before !== undefined) {
    const hasGetTime = window.before !== null && typeof window.before.getTime === 'function';
    const time = hasGetTime ? window.before.getTime() : Number.NaN;
    if (!Number.isFinite(time)) throw new ValidationError('before must be a valid Date', 'before');
  }
}
