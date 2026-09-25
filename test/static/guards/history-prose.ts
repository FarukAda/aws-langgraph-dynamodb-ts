import * as ts from 'typescript';

import { commentRanges } from './comments';

/**
 * Phrases that narrate what this package's code once did. A comment in `src`
 * states why the code is as it is now; the change that made it so is in
 * `CHANGELOG.md` and in the commit that made it. `no longer` is not here: it
 * as often describes the present ("an object that no longer exists").
 */
const HISTORY = /\b(?:used to|until now|previously|formerly)\b/i;

/** One comment, or a run of adjacent `//` comments, as source-ordered logical lines. */
interface CommentBlock {
  /** The 1-based source line of `lines[i]`, for each `i`. */
  readonly sourceLines: readonly number[];
  /** Each physical line's text with its `*`/`//` marker and surrounding whitespace stripped. */
  readonly lines: readonly string[];
}

/** The 1-based source line at byte offset `pos` of `source`. */
function lineAt(source: string, pos: number): number {
  return source.slice(0, pos).split('\n').length;
}

/** Whether `between`, the text separating two comments, is only whitespace with exactly one line break. */
function isAdjacent(between: string): boolean {
  return /^[ \t\r]*\n[ \t\r]*$/.test(between);
}

/** `text` — one `/* ... *\/` token, one or more physical lines — as its lines, markers stripped. */
function multiLineCommentLines(text: string): string[] {
  const body = text.replace(/^\/\*\*?/, '').replace(/\*\/$/, '');
  return body.split('\n').map((line) => line.replace(/^[ \t]*\*?[ \t]?/, '').trim());
}

/** Every comment in `source`, a run of adjacent `//` comments merged into one, in source order. */
function commentBlocks(source: string): CommentBlock[] {
  const tokens = commentRanges(source).map((range) => ({
    kind: range.kind,
    start: range.pos,
    end: range.end,
    text: source.slice(range.pos, range.end),
  }));

  const blocks: CommentBlock[] = [];
  for (let index = 0; index < tokens.length;) {
    const start = tokens[index];
    if (start.kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      const firstLine = lineAt(source, start.start);
      const lines = multiLineCommentLines(start.text);
      blocks.push({ sourceLines: lines.map((_, offset) => firstLine + offset), lines });
      index += 1;
      continue;
    }
    let end = index + 1;
    while (
      end < tokens.length &&
      tokens[end].kind === ts.SyntaxKind.SingleLineCommentTrivia &&
      isAdjacent(source.slice(tokens[end - 1].end, tokens[end].start))
    ) {
      end += 1;
    }
    const run = tokens.slice(index, end);
    blocks.push({
      sourceLines: run.map((token) => lineAt(source, token.start)),
      lines: run.map((token) => token.text.replace(/^\/\/[ \t]?/, '').trim()),
    });
    index = end;
  }
  return blocks;
}

/** The source lines of `block` on which the phrase, joined across its lines, starts. */
function historyLinesInBlock(block: CommentBlock): number[] {
  let joined = '';
  const ranges = block.lines.map((text, index) => {
    if (index > 0) joined += ' ';
    const from = joined.length;
    joined += text;
    return { from, to: joined.length, line: block.sourceLines[index] };
  });
  const pattern = new RegExp(HISTORY.source, 'gi');
  const lines: number[] = [];
  for (let match = pattern.exec(joined); match !== null; match = pattern.exec(joined)) {
    const range = ranges.find(
      (candidate) => match.index >= candidate.from && match.index < candidate.to,
    );
    if (range) lines.push(range.line);
  }
  return lines;
}

/**
 * The 1-based lines of `source` on which a comment narrates history. Code and
 * strings are not read. A phrase split across a line break — a JSDoc line
 * wrapped inside one `/** ... *\/` block, or a run of adjacent `//` comments —
 * is read as one comment, its lines rejoined with a single space; the line
 * reported is where the phrase starts, not where it ends.
 */
export function historyProse(source: string): number[] {
  const lines = new Set<number>();
  for (const block of commentBlocks(source)) {
    for (const line of historyLinesInBlock(block)) lines.add(line);
  }
  return [...lines];
}
