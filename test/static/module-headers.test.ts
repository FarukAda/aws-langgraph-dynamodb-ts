import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { MIN_HEADER_LENGTH, moduleHeaderProblem } from './guards/module-headers';
import { listSourceFiles, SRC_ROOT } from './guards/source-files';

const DECISION =
  ' * The paragraph that says why this is one decision, stated at enough length ' +
  'on its own to cross the header floor without any help from the other lines around it.';

describe('moduleHeaderProblem', () => {
  it('accepts a header whose first paragraph opens with Hides', () => {
    const source = [
      '/**',
      ' * Hides how pages are walked.',
      ' *',
      DECISION,
      ' */',
      '',
      'import x;',
    ];
    expect(moduleHeaderProblem(source.join('\n'))).toBeUndefined();
  });

  it("accepts the entry point's header, which names the package first", () => {
    const source = [
      '/**',
      ' * The package.',
      ' *',
      ' * Hides where anything lives.',
      ' *',
      DECISION,
      ' */',
      '',
      '',
    ];
    expect(moduleHeaderProblem(source.join('\n'), true)).toBeUndefined();
  });

  it('refuses that same second-paragraph Hides everywhere but the entry point', () => {
    const source = [
      '/**',
      ' * The package.',
      ' *',
      ' * Hides where anything lives.',
      ' *',
      DECISION,
      ' */',
      '',
      '',
    ];
    expect(moduleHeaderProblem(source.join('\n'))).toBe(
      'states no decision: its first paragraph does not open with "Hides "',
    );
  });

  it('refuses a file that opens with anything else', () => {
    expect(moduleHeaderProblem("import x from 'x';\n")).toBe('does not open with a /** header');
  });

  it('refuses a header that states no decision', () => {
    const source = ['/**', ' * Utilities for pages.', ' *', DECISION, ' */', ''];
    expect(moduleHeaderProblem(source.join('\n'))).toBe(
      'states no decision: its first paragraph does not open with "Hides "',
    );
  });

  it("refuses a header that states no decision, by the entry point's own two-paragraph rule too", () => {
    const source = ['/**', ' * Utilities for pages.', ' *', DECISION, ' */', ''];
    expect(moduleHeaderProblem(source.join('\n'), true)).toBe(
      'states no decision: neither of its first two paragraphs opens with "Hides "',
    );
  });

  it('refuses a header too short to state one', () => {
    expect(moduleHeaderProblem('/**\n * Hides pages.\n */\n\nimport x;')).toBe(
      'labels the file rather than stating a decision: under 160 characters',
    );
  });

  it('refuses a header whose prose is one character short of the floor', () => {
    const paragraph = `Hides ${'a'.repeat(153)}`;
    expect(paragraph.length).toBe(159);
    const source = `/**\n * ${paragraph}\n */\n\nimport x;`;
    expect(moduleHeaderProblem(source)).toBe(
      'labels the file rather than stating a decision: under 160 characters',
    );
  });

  it('accepts a header whose prose exactly meets the floor', () => {
    const paragraph = `Hides ${'a'.repeat(154)}`;
    expect(paragraph.length).toBe(160);
    const source = `/**\n * ${paragraph}\n */\n\nimport x;`;
    expect(moduleHeaderProblem(source)).toBeUndefined();
  });

  it('refuses a header padded with blank comment lines rather than prose', () => {
    const blankLines = Array.from({ length: 60 }, () => ' *').join('\n');
    const source = `/**\n * Hides x.\n *\n${blankLines}\n */\n\nimport x;`;
    // The raw block (markers and blank lines included) clears 160 characters
    // through padding alone; only its stripped prose may be measured.
    const end = source.indexOf('*/');
    expect(source.slice(0, end + 2).length).toBeGreaterThan(MIN_HEADER_LENGTH);
    expect(moduleHeaderProblem(source)).toBe(
      'labels the file rather than stating a decision: under 160 characters',
    );
  });

  it('refuses a header with no blank line after it', () => {
    const source = ['/**', ' * Hides how pages are walked.', ' *', DECISION, ' */', 'import x;'];
    expect(moduleHeaderProblem(source.join('\n'))).toBe('is not followed by a blank line');
  });

  it('tolerates a leading byte-order mark', () => {
    const source = [
      '/**',
      ' * Hides how pages are walked.',
      ' *',
      DECISION,
      ' */',
      '',
      'import x;',
    ];
    const bom = String.fromCharCode(0xfeff);
    expect(moduleHeaderProblem(`${bom}${source.join('\n')}`)).toBeUndefined();
  });

  it('tolerates CRLF line endings', () => {
    const source = [
      '/**',
      ' * Hides how pages are walked.',
      ' *',
      DECISION,
      ' */',
      '',
      'import x;',
    ];
    expect(moduleHeaderProblem(source.join('\r\n'))).toBeUndefined();
  });
});

describe('the source tree', () => {
  const files = listSourceFiles();
  const ENTRY_POINT = join(SRC_ROOT, 'index.ts');

  it('finds the modules to check, so a broken scan cannot pass silently', () => {
    expect(files.length).toBeGreaterThanOrEqual(80);
  });

  it('includes the entry point in the scanned tree', () => {
    expect(files).toContain(ENTRY_POINT);
  });

  it('opens every module, the entry point included, with the decision it hides', () => {
    const problems = files.flatMap((path) => {
      const problem = moduleHeaderProblem(readFileSync(path, 'utf8'), path === ENTRY_POINT);
      return problem === undefined
        ? []
        : [`${relative(SRC_ROOT, path).split(sep).join('/')} ${problem}`];
    });
    expect(problems).toEqual([]);
  });
});
