import { readFileSync } from 'node:fs';

import { countCodeLines, findOversizedFiles, MAX_SOURCE_LINES } from './guards/line-count';
import { listSourceFiles } from './guards/source-files';

describe('countCodeLines', () => {
  it('counts newline-separated lines, ignoring a single trailing newline', () => {
    expect(countCodeLines('a\nb\nc')).toBe(3);
    expect(countCodeLines('a\nb\n')).toBe(2);
    expect(countCodeLines('')).toBe(0);
  });

  /**
   * The cap governs how much code a file holds. Counting documentation made it
   * bite hardest on the best-documented files, where the cheapest way back
   * under it was to write less of it; `eslint`'s `max-lines` matches this.
   */
  it('does not count a line that holds nothing but a comment', () => {
    expect(countCodeLines('/**\n * doc\n */\nconst a = 1;')).toBe(1);
    expect(countCodeLines('// note\nconst a = 1;')).toBe(1);
  });

  /**
   * A bare token scanner has no parser to drive it through a template
   * literal's substitutions: the first `${x}` desynchronises it and every
   * later comment is swallowed into one template token, so a documented file
   * counts as if it were all code. This file is full of both.
   */
  it('still finds the comments after a template literal with substitutions', () => {
    const source = [
      '/** first */',
      'function a(field: string): string {',
      '  return `${field} must be a string`;',
      '}',
      '/** second */',
      'const b = 1;',
    ].join('\n');
    expect(countCodeLines(source)).toBe(4);
  });

  it('counts a blank line, which separates code rather than describing it', () => {
    expect(countCodeLines('const a = 1;\n\nconst b = 2;')).toBe(3);
  });

  it('counts a line holding code beside a comment exactly once', () => {
    expect(countCodeLines('const a = 1; // why\nconst b = 2;')).toBe(2);
    expect(countCodeLines('/* why */ const a = 1;')).toBe(1);
  });

  /**
   * Matching `//` and the block-comment opener textually would treat these as
   * comments and stop counting the code after them, so the scanner decides.
   */
  it('is not fooled by comment markers inside a string, template or regex', () => {
    expect(countCodeLines("const url = 'https://example.com';\nconst b = 2;")).toBe(2);
    expect(countCodeLines('const t = `/*`;\nconst b = 2;\nconst c = 3;')).toBe(3);
    expect(countCodeLines('const re = /a\\/\\/b/;\nconst b = 2;')).toBe(2);
  });
});

describe('findOversizedFiles', () => {
  it('flags a file over the cap and ignores one exactly at the cap', () => {
    const overBody = Array.from({ length: MAX_SOURCE_LINES + 1 }, () => 'x').join('\n');
    const atBody = Array.from({ length: MAX_SOURCE_LINES }, () => 'x').join('\n');
    const offenders = findOversizedFiles([
      { path: 'over.ts', text: overBody },
      { path: 'ok.ts', text: atBody },
    ]);
    expect(offenders).toEqual([{ path: 'over.ts', lines: MAX_SOURCE_LINES + 1 }]);
  });
});

describe('the actual source tree', () => {
  it('has no source file over the line cap', () => {
    const files = listSourceFiles().map((path) => ({ path, text: readFileSync(path, 'utf8') }));
    expect(findOversizedFiles(files)).toEqual([]);
  });
});
