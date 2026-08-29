import type { StoredMessage } from '@langchain/core/messages';

const MAX_TITLE_LENGTH = 80;

/**
 * Derive a session title from the first human message's text content, at most
 * {@link MAX_TITLE_LENGTH} characters including the ellipsis. Returns undefined
 * when there is no usable text.
 *
 * Truncation counts *code points*, not UTF-16 code units: slicing by index
 * could cut a surrogate pair in half, leaving a lone surrogate that no longer
 * round-trips through UTF-8. The ellipsis is also counted against the maximum
 * rather than appended past it.
 */
export function deriveTitle(messages: StoredMessage[]): string | undefined {
  const firstHuman = messages.find((message) => message.type === 'human');
  const content = firstHuman?.data.content;
  if (typeof content !== 'string' || content.length === 0) return undefined;
  const codePoints = [...content];
  if (codePoints.length <= MAX_TITLE_LENGTH) return content;
  return `${codePoints.slice(0, MAX_TITLE_LENGTH - 1).join('')}…`;
}
