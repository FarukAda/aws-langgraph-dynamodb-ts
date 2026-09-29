import { existsSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { findForbiddenTypes } from './guards/forbidden-types';
import { PARSER_MODULES } from './guards/parser-modules';
import { listSourceFiles, SRC_ROOT } from './guards/source-files';

describe('findForbiddenTypes', () => {
  it('flags the any keyword in a type position', () => {
    expect(findForbiddenTypes('const a: any = 1;')).toEqual([1]);
    expect(findForbiddenTypes('const a = x as any;')).toEqual([1]);
  });
  it('flags the unknown keyword', () => {
    expect(findForbiddenTypes('function f(x: unknown) {}')).toEqual([1]);
  });
  it('does not flag the identifier "unknown" used as a value name', () => {
    expect(findForbiddenTypes('const unknownCount = 1;')).toEqual([]);
  });
  it('does not flag clean code', () => {
    expect(findForbiddenTypes('export const a: number = 1;')).toEqual([]);
  });
});

describe('findForbiddenTypes in a parser module', () => {
  const inParser = (source: string): number[] => findForbiddenTypes(source, { parserModule: true });

  it('allows unknown as the type of a parameter of a parse* function, exported or not', () => {
    expect(
      inParser('export function parseA(value: unknown, field: string): string { return field; }'),
    ).toEqual([]);
    expect(inParser('function parseB(value?: unknown): number { return 1; }')).toEqual([]);
  });

  it('flags unknown anywhere else, even inside a parse* function', () => {
    expect(
      inParser(
        'function parseA(value: string): string { const x: unknown = value; return value; }',
      ),
    ).toEqual([1]);
    expect(inParser('function parseA(value: string): unknown { return value; }')).toEqual([1]);
    expect(inParser('function parseA(...values: unknown[]): void {}')).toEqual([1]);
    expect(inParser('function parseA(value: { a: unknown }): void {}')).toEqual([1]);
    expect(inParser('function parseA(value: unknown = 1): void {}')).toEqual([1]);
    expect(inParser('function parseA({ a }: unknown): void {}')).toEqual([1]);
    expect(inParser('function check(value: unknown): void {}')).toEqual([1]);
    expect(inParser('function parse(value: unknown): void {}')).toEqual([1]);
    expect(inParser('const parseA = (value: unknown): void => {};')).toEqual([1]);
    expect(inParser('type T = unknown;')).toEqual([1]);
  });

  it('still flags any, even in a parse* parameter', () => {
    expect(inParser('function parseA(value: any): void {}')).toEqual([1]);
  });
});

/**
 * A type guard's parameter is the other place a value is honestly not yet known
 * to be anything: the guard exists to find out. Typing it anything narrower
 * pushes a cast onto every caller, which is how the exported error guard came
 * to fail inside the very `catch` it is documented for.
 */
describe('findForbiddenTypes for a type guard', () => {
  it('allows unknown as the type of a plain parameter of a type-predicate function, anywhere', () => {
    expect(
      findForbiddenTypes('export function isX(value: unknown): value is X { return true; }'),
    ).toEqual([]);
    expect(findForbiddenTypes('function assertX(value: unknown): asserts value is X {}')).toEqual(
      [],
    );
  });

  it('still flags unknown in a guard written any other way', () => {
    expect(findForbiddenTypes('function isX(value: unknown): boolean { return true; }')).toEqual([
      1,
    ]);
    expect(
      findForbiddenTypes('function isX(...values: unknown[]): values is X[] { return true; }'),
    ).toEqual([1]);
    expect(
      findForbiddenTypes('function isX(value: unknown = 1): value is X { return true; }'),
    ).toEqual([1]);
    expect(findForbiddenTypes('const isX = (value: unknown): value is X => true;')).toEqual([1]);
    expect(
      findForbiddenTypes('function isX(value: { a: unknown }): value is X { return true; }'),
    ).toEqual([1]);
  });
});

describe('the actual source tree', () => {
  it('has no any, and no unknown outside a parameter of a parse* function in a parser module', () => {
    const offenders = listSourceFiles().flatMap((path) => {
      const file = relative(SRC_ROOT, path).split(sep).join('/');
      const lines = findForbiddenTypes(readFileSync(path, 'utf8'), {
        parserModule: PARSER_MODULES.includes(file),
      });
      return lines.map((line) => `${file}:${line}`);
    });
    expect(offenders).toEqual([]);
  });

  it('lists parser modules that exist, and eslint.config.ts allows exactly those', () => {
    const config = readFileSync(resolve(SRC_ROOT, '..', 'eslint.config.ts'), 'utf8');
    /**
     * A directory is required, which leaves out the entry-point block's
     * `'src/index.ts'`, and a glob names no module, which leaves out the
     * `'src/**\/*.ts'` of the block that holds all of `src` to the unsafe rules.
     */
    const listed = [...config.matchAll(/'src\/([^'*]+\/[^'*]+)'/g)].map((match) => match[1]).sort();
    expect(listed).toEqual([...PARSER_MODULES].sort());
    for (const module of PARSER_MODULES) expect(existsSync(resolve(SRC_ROOT, module))).toBe(true);
  });
});
