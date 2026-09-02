import { type StoredMessage, mapStoredMessagesToChatMessages } from '@langchain/core/messages';

import { MAX_PARTITION_ID_BYTES } from '../../shared/constants';
import { ValidationError } from '../../shared/errors/errors';
import { validateIdentifier } from '../../shared/validation/primitives';
import type { MessageWindow } from '../types';
import { SORT_KEY_SEPARATOR } from './keys';

/**
 * Validate a session id is a non-blank, separator- and control-char-free string
 * of at most 1024 bytes. Applied on every entry point, not just the write path: a bad value
 * used to reach DynamoDB and surface as a raw AWS SDK exception on reads,
 * while the identical value threw this library's typed `ValidationError` on a
 * write.
 */
export function validateSessionId(sessionId: string): void {
  validateIdentifier(sessionId, SORT_KEY_SEPARATOR, 'sessionId', MAX_PARTITION_ID_BYTES);
}

/**
 * Reject a message this adapter could never read back. The check *is* the
 * read side's own rebuild (`mapStoredMessagesToChatMessages`), so write and
 * read agree by construction: a `RemoveMessage`, or a tool, function or
 * generic message missing its required field, fails here with a typed error
 * instead of being persisted and then skipped or thrown by `getMessages`.
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
 * Validate a `getMessages` window: `limit`, when given, a positive integer;
 * `before`, when given, a valid `Date`. Checked before any DynamoDB call so a
 * bad value fails with a typed error rather than a raw `ValidationException`
 * (or, for an invalid Date, a NaN-derived sort key that matches nothing).
 */
export function validateMessageWindow(window: MessageWindow): void {
  if (window.limit !== undefined && (!Number.isInteger(window.limit) || window.limit < 1)) {
    throw new ValidationError('limit must be a positive integer', 'limit');
  }
  if (window.before !== undefined) {
    const time = typeof window.before.getTime === 'function' ? window.before.getTime() : Number.NaN;
    if (!Number.isFinite(time)) throw new ValidationError('before must be a valid Date', 'before');
  }
}
