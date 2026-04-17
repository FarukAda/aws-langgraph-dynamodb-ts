/**
 * Title generation utilities for chat sessions
 */

import { BaseMessage } from '@langchain/core/messages';

/**
 * Cap for *auto-generated* titles. Separate from the user-facing
 * validation cap in utils/validation.ts (MAX_TITLE_LENGTH = 200): we deliberately
 * produce shorter previews when auto-deriving a title from a long first message.
 */
const GENERATED_TITLE_MAX_LENGTH = 100;
const DEFAULT_TITLE = 'New Conversation';

/**
 * Generate a session title from the first message
 *
 * @param message - The first message in the session
 * @returns A generated title string
 */
export function generateTitle(message: BaseMessage): string {
  if (!message || !message.content) {
    return DEFAULT_TITLE;
  }

  // Convert content to string (it can be string or array of content parts)
  let contentText = '';
  if (typeof message.content === 'string') {
    contentText = message.content;
  } else if (Array.isArray(message.content)) {
    // Extract text from content parts if it's an array
    contentText = message.content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part === 'object' && part !== null && 'text' in part) {
          return (part as { text: string }).text;
        }
        return '';
      })
      .join(' ');
  }

  // Clean and truncate the title
  const cleaned = contentText
    .replace(/\s+/g, ' ') // Replace multiple whitespace with a single space
    .replace(/[\r\n]+/g, ' ') // Replace newlines with space
    .trim();

  if (!cleaned) {
    return DEFAULT_TITLE;
  }

  // Truncate to max length
  if (cleaned.length <= GENERATED_TITLE_MAX_LENGTH) {
    return cleaned;
  }

  // Truncate and add ellipsis
  return cleaned.substring(0, GENERATED_TITLE_MAX_LENGTH - 3) + '...';
}
