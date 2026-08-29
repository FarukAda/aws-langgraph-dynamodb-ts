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
