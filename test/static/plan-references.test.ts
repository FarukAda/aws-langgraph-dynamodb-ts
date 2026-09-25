import {
  handEditedDocFiles,
  isTextFileName,
  planReferenceScanFiles,
  planReferences,
  planReferencesIn,
} from './guards/plan-references';

describe('planReferencesIn', () => {
  it('flags a Ruling followed by a number', () => {
    expect(planReferencesIn('// Ruling 13 says otherwise', 'a.ts')).toEqual([
      { file: 'a.ts', line: 1, text: 'Ruling 13' },
    ]);
  });

  it('flags "fix round", case-insensitively, wherever it sits on the line', () => {
    expect(planReferencesIn("it('does x (Fix Round 2)', () => {})", 'a.ts')).toEqual([
      { file: 'a.ts', line: 1, text: 'Fix Round' },
    ]);
  });

  it('flags "task brief" and "brief" used as a noun for a plan document', () => {
    const source = [
      '// which the task brief forbids',
      "// Per the brief's implementer note",
      '// verified against the brief',
    ].join('\n');
    expect(planReferencesIn(source, 'a.ts').map((hit) => hit.line)).toEqual([1, 2, 3]);
  });

  it('does not flag "brief" used as an ordinary adjective', () => {
    expect(planReferencesIn('/** Waits a brief moment. */', 'a.ts')).toEqual([]);
  });

  it('flags a plan task id and a numbered plan task', () => {
    const source = ['// see P2.3 for context', '// Task 9 needs this first'].join('\n');
    expect(planReferencesIn(source, 'a.ts').map((hit) => hit.text)).toEqual(['P2.3', 'Task 9']);
  });

  it('flags a design-decision id only on a comment line', () => {
    const source = ['/** D1 is stricter than truthiness. */', "const x = 'D1';"].join('\n');
    expect(planReferencesIn(source, 'a.ts')).toEqual([{ file: 'a.ts', line: 1, text: 'D1' }]);
  });

  it('does not flag a call passing the string D1 as test data in code', () => {
    expect(planReferencesIn("checkpoint('cp-1', 'D1')", 'a.ts')).toEqual([]);
  });

  it('does not flag `new AbortController()` assigned to a variable named controller', () => {
    expect(planReferencesIn('const controller = new AbortController();', 'a.ts')).toEqual([]);
  });

  it('flags an audit finding id, in parentheses alone or in a list, or prefixed anywhere', () => {
    const source = [
      '// (H-10)',
      '// DDB-09',
      '// CORE-22',
      "it('refuses it (C1, I7)', () => {})",
      ' * per shard (audit H-08), so',
    ].join('\n');
    expect(planReferencesIn(source, 'a.ts').map((hit) => hit.text)).toEqual([
      '(H-10)',
      'H-10',
      'DDB-09',
      'CORE-22',
      '(C1, I7)',
      'H-08',
    ]);
  });

  it('leaves evidence claim ids, divergence ids, standards and id-shaped data alone', () => {
    const source = [
      '// (E-14) and (E-16, E-17)',
      '// V-26',
      '// UTF-16 (UTF-8)',
      '// CWE-117 (SHA-256)',
      "const createdAt = 'T-1';",
      "const writeId = 'WRITE-1';",
    ].join('\n');
    expect(planReferencesIn(source, 'a.ts')).toEqual([]);
  });

  it('reports the 1-based line of a hit past the first line', () => {
    expect(planReferencesIn('const a = 1;\n// fix round 2', 'a.ts')).toEqual([
      { file: 'a.ts', line: 2, text: 'fix round' },
    ]);
  });

  it('flags a numbered plan task written with a hyphen or underscore after capital Task', () => {
    const source = ['// Task-3 fix', '// Task_3 fix'].join('\n');
    expect(planReferencesIn(source, 'a.ts').map((hit) => hit.text)).toEqual(['Task-3', 'Task_3']);
  });

  it('flags lowercase "task" followed by a space then digits', () => {
    expect(planReferencesIn('// task 9 needs this', 'a.ts')).toEqual([
      { file: 'a.ts', line: 1, text: 'task 9' },
    ]);
  });

  it('does not flag lowercase task-N or task_N used as ordinary id data', () => {
    const source = ["const a = 'task-1';", "const b = 'task_1';"].join('\n');
    expect(planReferencesIn(source, 'a.ts')).toEqual([]);
  });

  it('flags Ruling case-insensitively, with an optional plural and no required space', () => {
    const source = ['// ruling 13', '// Ruling13', '// Rulings 13 and 14'].join('\n');
    expect(planReferencesIn(source, 'a.ts').map((hit) => hit.text)).toEqual([
      'ruling 13',
      'Ruling13',
      'Rulings 13',
    ]);
  });

  it('flags "fix round" separated by a hyphen or underscore', () => {
    const source = ['// fix-round 2', '// Fix_Round 2'].join('\n');
    expect(planReferencesIn(source, 'a.ts').map((hit) => hit.text)).toEqual([
      'fix-round',
      'Fix_Round',
    ]);
  });

  it('flags "see brief" and "per brief"', () => {
    const source = ['// see brief for detail', '// per brief, do X'].join('\n');
    expect(planReferencesIn(source, 'a.ts').map((hit) => hit.line)).toEqual([1, 2]);
  });

  it('flags a two-digit plan task id', () => {
    expect(planReferencesIn('// see P2.10', 'a.ts')).toEqual([
      { file: 'a.ts', line: 1, text: 'P2.10' },
    ]);
  });

  it('flags a finding id with a lowercase letter suffix, parenthesised and bare', () => {
    const source = ['// the timeline of (C-02b) explains it', '// see bare L-05b too'].join('\n');
    expect(planReferencesIn(source, 'a.ts').map((hit) => hit.text)).toEqual([
      '(C-02b)',
      'C-02b',
      'L-05b',
    ]);
  });

  it('does not flag legitimate BatchWriteItem retry-round prose', () => {
    const source = [
      '// Round 1: 5 items in, 3 persist (a,b,c), 2 (d,e) come back unprocessed.',
      '// Round 2 (retrying d,e): the call itself throws instead of resolving --',
    ].join('\n');
    expect(planReferencesIn(source, 'a.ts')).toEqual([]);
  });
});

describe('citations of planning files that are not in the repository', () => {
  it('flags a section sign followed by a number', () => {
    expect(planReferencesIn(' * (design §11.6)', 'a.ts').map((hit) => hit.text)).toEqual(['§11']);
  });

  it('flags the untracked evidence and design file names', () => {
    const source = [
      '// see live-validation.md',
      '// live-validation-delete.md',
      '// design-offload-durability',
      '// .superpowers/sdd',
    ].join('\n');
    expect(planReferencesIn(source, 'a.ts').map((hit) => hit.line)).toEqual([1, 2, 3, 4]);
  });
});

describe('planReferences', () => {
  it('finds no plan-process reference across the real tree', () => {
    expect(planReferences()).toEqual([]);
  });

  it('reads the code and the hand-edited docs, skipping only its own two files', () => {
    const files = planReferenceScanFiles();
    expect(files).toEqual(
      expect.arrayContaining([
        'src/index.ts',
        'test/surface/harness.mjs',
        'README.md',
        'CHANGELOG.md',
        'CONTRIBUTING.md',
        'package.json',
        '.github/workflows/ci.yml',
      ]),
    );
    expect(files).not.toContain('test/static/guards/plan-references.ts');
    expect(files).not.toContain('test/static/plan-references.test.ts');
    expect(files.filter((file) => file.startsWith('docs/'))).toEqual([]);
  });
});

describe('handEditedDocFiles', () => {
  it('lists the hand-edited root files and .github, never the generated docs', () => {
    const files = handEditedDocFiles();
    expect(files).toEqual(
      expect.arrayContaining([
        'README.md',
        'CHANGELOG.md',
        'CONTRIBUTING.md',
        'SECURITY.md',
        'SUPPORT.md',
        'CODE_OF_CONDUCT.md',
        'docker-compose.yml',
        'knip.json',
        'typedoc.json',
        'package.json',
        'tsconfig.json',
        'tsconfig.build.json',
        'jest.config.ts',
        'eslint.config.ts',
        '.github/CODEOWNERS',
        '.github/workflows/ci.yml',
      ]),
    );
    expect(files.filter((file) => file.startsWith('docs/'))).toEqual([]);
  });

  it('reads a file under .github as text unless its extension is a known binary one', () => {
    expect(isTextFileName('CODEOWNERS')).toBe(true);
    expect(isTextFileName('ci.yml')).toBe(true);
    expect(isTextFileName('annotate-jest.mjs')).toBe(true);
    expect(isTextFileName('release.sh')).toBe(true);
    expect(isTextFileName('social-preview.png')).toBe(false);
    expect(isTextFileName('LOGO.PNG')).toBe(false);
    expect(isTextFileName('diagram.pdf')).toBe(false);
  });

  it('skips the npm lockfile and root files of other kinds', () => {
    const files = handEditedDocFiles();
    expect(files).not.toContain('package-lock.json');
    expect(files).not.toContain('LICENSE');
    expect(files).not.toContain('.gitignore');
  });
});
