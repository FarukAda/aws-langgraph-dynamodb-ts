import {
  type BaseMessage,
  type StoredMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
} from '@langchain/core/messages';

import { MAX_PARTITION_ID_BYTES } from '../../shared/constants';
import { ValidationError } from '../../shared/errors/errors';
import { redactedMessage } from '../../shared/logging/secret-patterns';
import { ULID_TIME_RANGE_MS } from '../../shared/ulid';
import { validateIdentifier, validateLimit } from '../../shared/validation/primitives';
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
 * Refuse a `messages` argument that is not an array, before any per-message
 * check runs.
 *
 * Accepts: `messages` — declared `BaseMessage[]` for a caller whose types
 * hold; anything else is rejected here rather than reaching `.length` or
 * `.map` downstream, both of which raise a raw `TypeError` on a non-array.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `messages`.
 */
export function validateMessageList(messages: BaseMessage[]): void {
  if (!Array.isArray(messages)) {
    throw new ValidationError('messages must be an array', 'messages');
  }
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
        `messages[${index}] is not a LangChain message: ${redactedMessage(error as Error)}`,
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
        `messages[${index}] of type "${message.type}" cannot be stored: ` +
          redactedMessage(error as Error),
        'messages',
      );
    }
  });
}

/**
 * Validate a `getMessages` window.
 *
 * Accepts: `limit` — absent asks for the whole session; otherwise the
 * package-wide page rule at the higher of its two floors, an integer from 1 to
 * the page ceiling. `0` is refused rather than answered with nothing: for a
 * window into a conversation it is far more likely a bug than a request. That
 * is the whole reason, and it holds here and nowhere else because of what an
 * empty result does next. A listing answered with nothing is visibly empty to
 * the caller that asked for it; this window is what `forSession` hands
 * `RunnableWithMessageHistory`, so answering it with nothing tells the model
 * the conversation never happened, and the chain persists the answer it gives
 * on that basis as the transcript. `before` — absent means up to now;
 * otherwise a `Date` whose time is finite *and* inside the range a message id
 * encodes, `[0, {@link ULID_TIME_RANGE_MS})`. `null` is refused, naming
 * `before`, rather than read as "up to now". A `Date` is duck-typed, since one
 * from another realm is still a date.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `limit` or `before`, before any DynamoDB
 * call. `before: null` used to reach `null.getTime`, a property access the
 * boundary branded `UpstreamError` instead of naming the caller's mistake; an
 * invalid `Date` would otherwise derive a NaN sort key that matches nothing
 * and read as an empty conversation. A pre-epoch `Date` was worse than either:
 * the bound built from it sorted above every real id, so the window came back
 * holding the entire conversation the caller had asked to exclude. Past the
 * range the bound wrapped to the lowest prefix and the window came back empty.
 * The range is checked here, at the boundary that can name `before`, rather
 * than left to the id encoder, which cannot.
 *
 * Guarantees: this one check serves both documented promises a conversation
 * window carries — `getMessages(sessionId, options)` and the `window` a
 * `forSession` adapter is constructed with — so neither can read a session the
 * other would refuse to.
 */
export function validateMessageWindow(window: MessageWindow): void {
  /**
   * The only floor of 1 in the package: a window feeds a model, and an empty
   * conversation is not a visibly empty answer but an invented one.
   */
  if (window.limit !== undefined) validateLimit(window.limit, 1);
  if (window.before !== undefined) {
    const hasGetTime = window.before !== null && typeof window.before.getTime === 'function';
    const time = hasGetTime ? window.before.getTime() : Number.NaN;
    if (!Number.isFinite(time)) throw new ValidationError('before must be a valid Date', 'before');
    if (time < 0 || time >= ULID_TIME_RANGE_MS) {
      throw new ValidationError(
        'before must be a Date from the epoch onwards and before the year 37648: the bound is ' +
          'the message id of that instant, and a message id encodes its millisecond in ten ' +
          'base-32 characters, which hold no instant outside that range',
        'before',
      );
    }
  }
}
