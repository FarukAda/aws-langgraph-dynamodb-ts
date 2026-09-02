const NEEDLE = 'withDynamoDBRetry(';

/** Index of the `)` closing the call whose `(` sits at `open`, honouring strings and nesting. */
function closingParen(
  text: string,
  open: number,
): { close: number; hasArgumentSeparator: boolean } {
  let depth = 0;
  let quote: string | undefined;
  let hasArgumentSeparator = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (quote !== undefined) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
      if (depth === 0) return { close: i, hasArgumentSeparator };
    } else if (ch === ',' && depth === 1 && !/^\s*\)/.test(text.slice(i + 1))) {
      hasArgumentSeparator = true;
    }
  }
  return { close: text.length, hasArgumentSeparator };
}

/**
 * 1-based line numbers of every `withDynamoDBRetry(` call in `text` that passes
 * only the operation. Adapter code must always pass the context's retry
 * options (or an object spreading them), otherwise a caller's `retry` policy
 * and the retry debug log silently stop applying to that call.
 */
export function findRetryCallsWithoutOptions(text: string): number[] {
  const lines: number[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(NEEDLE, from);
    if (at < 0) return lines;
    const { close, hasArgumentSeparator } = closingParen(text, at + NEEDLE.length - 1);
    if (!hasArgumentSeparator) lines.push(text.slice(0, at).split('\n').length);
    from = close + 1;
  }
}
