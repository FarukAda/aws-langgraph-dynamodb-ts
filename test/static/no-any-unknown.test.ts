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
    expect(inParser('function check(value: unknown): void {}')).toEqual([1]);
    expect(inParser('function parse(value: unknown): void {}')).toEqual([1]);
    expect(inParser('const parseA = (value: unknown): void => {};')).toEqual([1]);
    expect(inParser('type T = unknown;')).toEqual([1]);
  });

  it('still flags any, even in a parse* parameter', () => {
    expect(inParser('function parseA(value: any): void {}')).toEqual([1]);
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
    /** A directory is required, which leaves out the entry-point block's `'src/index.ts'`. */
    const listed = [...config.matchAll(/'src\/([^']+\/[^']+)'/g)].map((match) => match[1]).sort();
    expect(listed).toEqual([...PARSER_MODULES].sort());
    for (const module of PARSER_MODULES) expect(existsSync(resolve(SRC_ROOT, module))).toBe(true);
  });
});
