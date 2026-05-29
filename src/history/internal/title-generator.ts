import type { StoredMessage } from '@langchain/core/messages';

const MAX_TITLE_LENGTH = 80;

/**
 * Derive a session title from the first human message's text content, truncated
 * to {@link MAX_TITLE_LENGTH}. Returns undefined when there is no usable text.
 */
export function deriveTitle(messages: StoredMessage[]): string | undefined {
  const firstHuman = messages.find((message) => message.type === 'human');
  const content = firstHuman?.data.content;
  if (typeof content !== 'string' || content.length === 0) return undefined;
  return content.length > MAX_TITLE_LENGTH ? `${content.slice(0, MAX_TITLE_LENGTH)}…` : content;
}
