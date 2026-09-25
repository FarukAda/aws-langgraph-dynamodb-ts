/** The fewest characters a header may have, as in the reference repository: less labels a file. */
export const MIN_HEADER_LENGTH = 160;

/**
 * Why `source` does not open with a module header, or `undefined` when it
 * does (coding guidelines, rule 3; decision record 22). A header is a `/**`
 * block that is the first thing in the file; its first paragraph opens with
 * `Hides ` — or its second, so the package entry point can name the package
 * first — it is at least {@link MIN_HEADER_LENGTH} characters long, and a
 * blank line follows it.
 */
export function moduleHeaderProblem(source: string): string | undefined {
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
  if (!paragraphs.slice(0, 2).some((paragraph) => paragraph.startsWith('Hides '))) {
    return 'states no decision: neither of its first two paragraphs opens with "Hides "';
  }
  if (block.length < MIN_HEADER_LENGTH) {
    return `labels the file rather than stating a decision: under ${MIN_HEADER_LENGTH} characters`;
  }
  if (!text.slice(end + 2).startsWith('\n\n')) return 'is not followed by a blank line';
  return undefined;
}
