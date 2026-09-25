/** The fewest characters of paragraph prose a header may total, as in the reference repository: less labels a file. */
export const MIN_HEADER_LENGTH = 160;

/**
 * Why `source` does not open with a module header, or `undefined` when it
 * does (coding guidelines, rule 3; decision record 22). A header is a `/**`
 * block that is the first thing in the file; its first paragraph opens with
 * `Hides ` — or, only when `isEntryPoint` is true, its second, so the package
 * entry point alone can name the package first — its paragraphs, joined,
 * total at least {@link MIN_HEADER_LENGTH} characters of prose once the
 * comment's own opening, closing and per-line ` * ` markers are stripped,
 * and a blank line follows the block.
 */
export function moduleHeaderProblem(source: string, isEntryPoint = false): string | undefined {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('/**')) return 'does not open with a /** header';
  const end = text.indexOf('*/');
  const block = text.slice(0, end + 2);
  const paragraphs = block
    .split('\n')
    .slice(1, -1)
    .map((line) => line.replace(/^\s*\* ?/, '').trim())
    .join('\n')
    .split(/\n\n+/)
    .map((paragraph) => paragraph.replace(/\n/g, ' ').trim())
    .filter((paragraph) => paragraph !== '');
  const decisionCandidates = isEntryPoint ? paragraphs.slice(0, 2) : paragraphs.slice(0, 1);
  if (!decisionCandidates.some((paragraph) => paragraph.startsWith('Hides '))) {
    return isEntryPoint
      ? 'states no decision: neither of its first two paragraphs opens with "Hides "'
      : 'states no decision: its first paragraph does not open with "Hides "';
  }
  const proseLength = paragraphs.join(' ').length;
  if (proseLength < MIN_HEADER_LENGTH) {
    return `labels the file rather than stating a decision: under ${MIN_HEADER_LENGTH} characters`;
  }
  if (!text.slice(end + 2).startsWith('\n\n')) return 'is not followed by a blank line';
  return undefined;
}
