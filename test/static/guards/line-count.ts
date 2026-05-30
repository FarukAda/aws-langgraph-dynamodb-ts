/** Maximum allowed lines per source file (CLAUDE.md Files & separation rule). */
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

/**
 * Count the number of lines in `text`. A single trailing newline does not add
 * an empty final line; an empty string is zero lines.
 */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  const trimmed = text.endsWith('\n') ? text.slice(0, -1) : text;
  return trimmed.split('\n').length;
}

/** Return every file whose line count exceeds {@link MAX_SOURCE_LINES}. */
export function findOversizedFiles(files: readonly SourceFile[]): OversizedFile[] {
  const offenders: OversizedFile[] = [];
  for (const file of files) {
    const lines = countLines(file.text);
    if (lines > MAX_SOURCE_LINES) offenders.push({ path: file.path, lines });
  }
  return offenders;
}
