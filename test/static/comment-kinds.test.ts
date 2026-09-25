import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';

import { commentViolations } from './guards/comments';
import { listSourceFiles, SRC_ROOT } from './guards/source-files';

describe('commentViolations', () => {
  it('accepts JSDoc as the module header and on declarations', () => {
    const source = [
      '/**',
      ' * Hides x.',
      ' */',
      '',
      '/** A. */',
      'export const a = 1;',
      '',
      'class C {',
      '  /** B. */',
      '  b = 2;',
      '}',
    ].join('\n');
    expect(commentViolations(source)).toEqual([]);
  });

  it('accepts JSDoc on a top-level declaration and on a class member', () => {
    const source = [
      '/** A top-level constant. */',
      'export const a = 1;',
      '',
      'class C {',
      '  /** A class member. */',
      '  b = 2;',
      '}',
    ].join('\n');
    expect(commentViolations(source)).toEqual([]);
  });

  it('refuses a JSDoc block that documents a local declaration inside a function body', () => {
    const source = 'function f() {\n  /** the answer */\n  const x = 42;\n  return x;\n}';
    expect(commentViolations(source)).toEqual([{ line: 2, rule: 'jsdoc-inside-body' }]);
  });

  it('refuses a JSDoc block on a nested declaration, several function bodies deep', () => {
    const source = [
      'function outer() {',
      '  return function inner() {',
      '    /** the answer */',
      '    const x = 42;',
      '    return x;',
      '  };',
      '}',
    ].join('\n');
    expect(commentViolations(source)).toEqual([{ line: 3, rule: 'jsdoc-inside-body' }]);
  });

  it('accepts a line comment inside a function body, above a statement or a local', () => {
    const source = 'function f() {\n  // why\n  g();\n  // and this\n  const x = 1;\n}';
    expect(commentViolations(source)).toEqual([]);
  });

  it('accepts a line comment above a module-level statement that declares nothing', () => {
    expect(commentViolations('enum E { A }\n\n// why it is frozen\nObject.freeze(E);')).toEqual([]);
  });

  it('refuses a JSDoc block that documents no declaration', () => {
    expect(commentViolations('function f() {\n  /** why */\n  g();\n}')).toEqual([
      { line: 2, rule: 'jsdoc-documents-nothing' },
    ]);
  });

  it('refuses a JSDoc block left at the end of a block, even as the first comment', () => {
    expect(commentViolations('function f() {\n  g();\n  /** dangling */\n}')).toEqual([
      { line: 3, rule: 'jsdoc-documents-nothing' },
    ]);
  });

  it('refuses a line comment as the documentation of a declaration outside a body', () => {
    expect(commentViolations('// the answer\nexport const a = 42;')).toEqual([
      { line: 1, rule: 'line-comment-on-declaration' },
    ]);
  });

  it('refuses a plain block comment', () => {
    expect(commentViolations('/* narrative */\nconst a = 1;')).toEqual([
      { line: 1, rule: 'block' },
    ]);
  });

  it('refuses a directive comment in either form', () => {
    const source = [
      'function f() {',
      '  // eslint-disable-next-line no-console',
      '  g();',
      '}',
      '/** @ts-expect-error */',
      'const a = 1;',
    ].join('\n');
    expect(commentViolations(source)).toEqual([
      { line: 2, rule: 'directive' },
      { line: 5, rule: 'directive' },
    ]);
  });

  it('refuses a trailing line-comment directive on the same line as code', () => {
    expect(commentViolations('console.log(1); // eslint-disable-line no-console')).toEqual([
      { line: 1, rule: 'directive' },
    ]);
  });

  it('refuses a trailing block-comment directive on the same line as code', () => {
    expect(commentViolations('export const z = 1; /* eslint-disable */')).toEqual([
      { line: 1, rule: 'directive' },
    ]);
  });

  it('finds a stray JSDoc block after a template literal with a substitution', () => {
    const source = 'const a = `x${1}y`;\nfunction f() {\n  g();\n  /** stray */\n}';
    expect(commentViolations(source)).toEqual([{ line: 4, rule: 'jsdoc-documents-nothing' }]);
  });
});

describe('the actual source tree', () => {
  it('writes interface documentation as JSDoc and every other comment as a line comment', () => {
    const offenders = listSourceFiles().flatMap((path) =>
      commentViolations(readFileSync(path, 'utf8')).map(
        ({ line, rule }) => `${relative(SRC_ROOT, path).split(sep).join('/')}:${line} ${rule}`,
      ),
    );
    expect(offenders).toEqual([]);
  });
});
