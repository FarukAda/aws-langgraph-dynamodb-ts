import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';

import { moduleHeaderProblem } from './guards/module-headers';
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
    expect(moduleHeaderProblem(source.join('\n'))).toBeUndefined();
  });

  it('refuses a file that opens with anything else', () => {
    expect(moduleHeaderProblem("import x from 'x';\n")).toBe('does not open with a /** header');
  });

  it('refuses a header that states no decision', () => {
    const source = ['/**', ' * Utilities for pages.', ' *', DECISION, ' */', ''];
    expect(moduleHeaderProblem(source.join('\n'))).toBe(
      'states no decision: neither of its first two paragraphs opens with "Hides "',
    );
  });

  it('refuses a header too short to state one', () => {
    expect(moduleHeaderProblem('/**\n * Hides pages.\n */\n\nimport x;')).toBe(
      'labels the file rather than stating a decision: under 160 characters',
    );
  });

  it('refuses a header with no blank line after it', () => {
    const source = ['/**', ' * Hides how pages are walked.', ' *', DECISION, ' */', 'import x;'];
    expect(moduleHeaderProblem(source.join('\n'))).toBe('is not followed by a blank line');
  });
});

describe('the source tree', () => {
  const files = listSourceFiles();

  it('finds the modules to check, so a broken scan cannot pass silently', () => {
    expect(files.length).toBeGreaterThanOrEqual(80);
  });

  it('opens every module, the entry point included, with the decision it hides', () => {
    const problems = files.flatMap((path) => {
      const problem = moduleHeaderProblem(readFileSync(path, 'utf8'));
      return problem === undefined
        ? []
        : [`${relative(SRC_ROOT, path).split(sep).join('/')} ${problem}`];
    });
    expect(problems).toEqual([]);
  });
});
