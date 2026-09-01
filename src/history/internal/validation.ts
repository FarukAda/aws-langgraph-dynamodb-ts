import { type StoredMessage, mapStoredMessagesToChatMessages } from '@langchain/core/messages';

import { ValidationError } from '../../shared/errors/errors';
import { validateIdentifier } from '../../shared/validation/primitives';
import { SORT_KEY_SEPARATOR } from './keys';

/**
 * Validate a session id is a non-empty, separator- and control-char-free
 * string. Applied on every entry point, not just the write path: a bad value
 * used to reach DynamoDB and surface as a raw AWS SDK exception on reads,
 * while the identical value threw this library's typed `ValidationError` on a
 * write.
 */
export function validateSessionId(sessionId: string): void {
  validateIdentifier(sessionId, SORT_KEY_SEPARATOR, 'sessionId');
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
