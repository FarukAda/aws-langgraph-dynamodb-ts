import ts from 'typescript';

/** Maximum allowed lines per source file (CONTRIBUTING.md, "The rules the guards enforce"). */
export const MAX_SOURCE_LINES = 150;

/** A source file's path and raw text, used by the oversized-file guard. */
export interface SourceFile {
  path: string;
  text: string;
}

/** A flagged file with its measured line count. */
export interface OversizedFile {
  path: string;
  lines: number;
}

/** What a line holds, once the file has been parsed. */
interface LineContent {
  code: boolean;
  comment: boolean;
}

/** Mark every line `start`..`end` spans with `field`. */
function mark(
  lines: LineContent[],
  source: ts.SourceFile,
  range: ts.TextRange,
  field: keyof LineContent,
): void {
  const last = source.getLineAndCharacterOfPosition(Math.min(range.end, source.text.length)).line;
  for (let line = source.getLineAndCharacterOfPosition(range.pos).line; line <= last; line += 1) {
    lines[line][field] = true;
  }
}

/**
 * Classify every line of `source` as holding code, a comment, both or neither.
 *
 * The file is **parsed**, not scanned token by token: a bare scanner has no
 * parser to drive it through a template literal's substitutions, so the first
 * `` `${x}` `` desynchronises it and every later comment is swallowed into one
 * template token. Comments come from the parsed trivia and code from the
 * parsed tokens, both of which survive any literal in the file.
 */
function classifyLines(text: string): LineContent[] {
  const source = ts.createSourceFile('probe.ts', text, ts.ScriptTarget.Latest, true);
  const lines: LineContent[] = text.split('\n').map(() => ({ code: false, comment: false }));
  const seen = new Set<number>();
  const visit = (node: ts.Node): void => {
    for (const range of [
      ...(ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []),
      ...(ts.getTrailingCommentRanges(text, node.getEnd()) ?? []),
    ]) {
      if (seen.has(range.pos)) continue;
      seen.add(range.pos);
      mark(lines, source, range, 'comment');
    }
    if (node.getChildCount(source) === 0 && node.getEnd() > node.getStart(source)) {
      mark(lines, source, { pos: node.getStart(source), end: node.getEnd() }, 'code');
    }
    node.forEachChild(visit);
  };
  visit(source);
  for (const range of ts.getLeadingCommentRanges(text, source.endOfFileToken.getFullStart()) ??
    []) {
    mark(lines, source, range, 'comment');
  }
  return lines;
}

/**
 * Count the lines of `text` that count toward the cap: every line except one
 * that holds nothing but a comment. A blank line still counts, and a line that
 * holds code beside a comment counts once.
 *
 * This is the measurement `eslint`'s `max-lines` makes with
 * `{ skipComments: true, skipBlankLines: false }`, which is the rule this
 * guard exists to hold even where that rule has been disabled inline. The cap
 * governs how much code a file holds; documenting it well must never be the
 * thing that pushes it over.
 */
export function countCodeLines(text: string): number {
  if (text.length === 0) return 0;
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return classifyLines(trimmed).filter((line) => line.code || !line.comment).length;
}

/** Return every file whose counted line total exceeds {@link MAX_SOURCE_LINES}. */
export function findOversizedFiles(files: readonly SourceFile[]): OversizedFile[] {
  const offenders: OversizedFile[] = [];
  for (const file of files) {
    const lines = countCodeLines(file.text);
    if (lines > MAX_SOURCE_LINES) offenders.push({ path: file.path, lines });
  }
  return offenders;
}
